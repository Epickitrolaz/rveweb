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
def gpu_info() -> dict:
    nodes = glob.glob("/dev/dri/renderD*")
    info = {"available": False, "name": "No GPU", "backend": "none"}
    if not nodes:
        return info

    info["available"] = True
    info["name"] = "Vulkan GPU"
    info["backend"] = "vulkan"
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
                    current = {}
                elif "=" in stripped:
                    key, _, value = stripped.partition("=")
                    current[key.strip()] = value.strip()
            if current:
                devices.append(current)
            physical = [
                d for d in devices
                if d.get("deviceType", "").startswith("PHYSICAL_DEVICE_TYPE")
                and "CPU" not in d.get("deviceType", "")
            ]
            if physical:
                info["name"] = physical[0].get("deviceName", info["name"])
                info["driver"] = physical[0].get("driverName", "").lower()
    except (OSError, subprocess.SubprocessError) as exc:
        log.debug("vulkaninfo unavailable: %s", exc)
    info["backend"] = "vulkan"
    return info


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
