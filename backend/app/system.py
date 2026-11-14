"""Live host and GPU information for the console."""

from __future__ import annotations

import glob
import logging
import os
import shutil
import subprocess
import time
from functools import lru_cache

from . import config
from .catalog import model_catalog

log = logging.getLogger(__name__)

_started_at = time.monotonic()


@lru_cache(maxsize=1)
def _nvidia_info() -> dict | None:
    smi = shutil.which("nvidia-smi")
    if not smi:
        return None
    try:
        result = subprocess.run(
            [smi, "--query-gpu=name,driver_version", "--format=csv,noheader"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        line = (result.stdout or "").strip().splitlines()[0] if result.stdout else ""
        if result.returncode != 0 or not line:
            return None
        name, _, driver = line.partition(",")
        return {"name": name.strip() or "NVIDIA GPU", "driver": driver.strip()}
    except (OSError, subprocess.SubprocessError, IndexError) as exc:
        log.debug("nvidia-smi unavailable: %s", exc)
        return None


@lru_cache(maxsize=1)
def _vulkan_info() -> dict:
    info = {"available": False, "name": "Vulkan GPU", "driver": "", "index": 0}
    try:
        result = subprocess.run(
            ["vulkaninfo", "--summary"],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        if result.returncode == 0:
            current: dict[str, str] = {}
            devices: list[dict[str, str]] = []
            for line in result.stdout.splitlines():
                stripped = line.strip()
                if stripped.startswith("GPU") and stripped.endswith(":"):
                    if current:
                        devices.append(current)
                    current = {"index": stripped[3:-1]}
                elif "=" in stripped:
                    key, _, value = stripped.partition("=")
                    current[key.strip()] = value.strip()
            if current:
                devices.append(current)
            physical = [
                device for device in devices
                if device.get("deviceType", "").startswith("PHYSICAL_DEVICE_TYPE")
                and "CPU" not in device.get("deviceType", "")
                and "llvmpipe" not in device.get("deviceName", "").lower()
            ]
            if physical:
                # Prefer a real hardware GPU with a vendor driver over any software fallback.
                chosen = next(
                    (d for d in physical if any(word in d.get("deviceName", "") for word in ("NVIDIA", "Tesla", "GeForce", "Quadro", "Radeon"))),
                    physical[0],
                )
                info["available"] = True
                info["name"] = chosen.get("deviceName", info["name"])
                info["driver"] = chosen.get("driverName", "").lower()
                try:
                    info["index"] = int(chosen.get("index", "0"))
                except ValueError:
                    info["index"] = 0
                return info
    except (OSError, subprocess.SubprocessError) as exc:
        log.debug("vulkaninfo unavailable: %s", exc)
    if glob.glob("/dev/dri/renderD*"):
        info["available"] = True
        info["name"] = "Vulkan GPU"
    return info


@lru_cache(maxsize=1)
def cuda_onnx_available() -> bool:
    try:
        import onnxruntime as ort

        return "CUDAExecutionProvider" in ort.get_available_providers()
    except Exception:
        return False


@lru_cache(maxsize=1)
def gpu_info() -> dict:
    cuda = _nvidia_info()
    vulkan = _vulkan_info()
    if cuda:
        name = cuda["name"]
        backend = "cuda"
        driver = cuda["driver"]
    elif vulkan["available"]:
        name = vulkan["name"]
        backend = "vulkan"
        driver = vulkan["driver"]
    else:
        name = "No GPU"
        backend = "none"
        driver = ""
    return {
        "available": bool(cuda or vulkan["available"]),
        "name": name,
        "backend": backend,
        "driver": driver,
        "cuda": bool(cuda),
        "vulkan": bool(vulkan["available"]),
        "cudaOnnx": bool(cuda and cuda_onnx_available()),
        "vulkanIndex": int(vulkan.get("index", 0)),
    }


def _memory_mb() -> tuple[int, int]:
    total = available = 0
    try:
        with open("/proc/meminfo", "r", encoding="utf-8") as handle:
            for line in handle:
                if line.startswith("MemTotal:"):
                    total = int(line.split()[1]) // 1024
                elif line.startswith("MemAvailable:"):
                    available = int(line.split()[1]) // 1024
    except (OSError, ValueError, IndexError):
        pass

    # Containers inherit the host's /proc/meminfo; prefer cgroup limits when present.
    try:
        with open("/sys/fs/cgroup/memory.max", "r", encoding="utf-8") as handle:
            raw_max = handle.read().strip()
        if raw_max and raw_max != "max":
            cgroup_max = int(raw_max) // (1024 * 1024)
            with open("/sys/fs/cgroup/memory.current", "r", encoding="utf-8") as handle:
                current = int(handle.read().strip()) // (1024 * 1024)
            if cgroup_max > 0:
                total = cgroup_max
                available = max(0, cgroup_max - current)
    except (OSError, ValueError):
        pass
    return total, available


def _effective_cores() -> int:
    cores = os.cpu_count() or 1
    try:
        with open("/sys/fs/cgroup/cpu.max", "r", encoding="utf-8") as handle:
            quota, period = handle.read().split()
        if quota != "max":
            cores = max(1, int(round(int(quota) / int(period))))
    except (OSError, ValueError):
        pass
    return cores


def _disk_free_gb() -> float:
    try:
        usage = shutil.disk_usage(config.DATA_DIR)
        return round(usage.free / (1024 ** 3), 2)
    except OSError:
        return 0.0


def system_info(queue: dict[str, int]) -> dict:
    load1 = 0.0
    try:
        load1 = round(os.getloadavg()[0], 2)
    except (OSError, AttributeError):
        pass
    total_mb, available_mb = _memory_mb()
    return {
        "gpu": gpu_info(),
        "cpu": {"cores": _effective_cores(), "load1": load1},
        "memory": {"totalMb": total_mb, "availableMb": available_mb},
        "storage": {"freeGb": _disk_free_gb()},
        "queue": {
            "active": queue.get("active", 0),
            "queued": queue.get("queued", 0),
            "maxActive": config.MAX_ACTIVE_JOBS,
            "maxQueue": config.MAX_QUEUE,
        },
        "models": model_catalog(),
        "limits": {
            "maxUploadMb": config.MAX_UPLOAD_MB,
            "minFreeGb": config.MIN_FREE_GB,
            "retentionHours": config.RETENTION_HOURS,
            "maxOutputPixels": config.MAX_OUTPUT_PIXELS,
        },
        "version": config.VERSION,
    }


def uptime_seconds() -> float:
    return round(time.monotonic() - _started_at, 1)
