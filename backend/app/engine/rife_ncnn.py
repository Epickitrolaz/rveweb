"""RIFE 4.6–4.26 interpolation through the ncnn Vulkan Python wrapper."""

from __future__ import annotations

import logging
from pathlib import Path

import cv2
import numpy as np

from .. import config
from ..catalog import INTERPOLATORS
from .ffmpeg import EngineError
from .rife import SCENE_CUT_THRESHOLD

log = logging.getLogger(__name__)


class RifeNcnnInterpolator:
    def __init__(
        self,
        model_id: str,
        *,
        mode: str = "auto",
        max_height: int = 0,
        threads: int | None = None,
    ) -> None:
        spec = INTERPOLATORS.get(model_id)
        if spec is None or spec.engine != "ncnn":
            raise EngineError(f"unknown ncnn interpolation model: {model_id}")
        self.spec = spec
        self.mode = mode
        self.max_height = max_height
        self.threads = max(1, threads or config.RIFE_THREADS)
        model_dir = config.MODEL_DIR / "rife-ncnn" / spec.model_dir
        if not (model_dir / "flownet.param").exists() or not (model_dir / "flownet.bin").exists():
            raise EngineError(f"the {spec.label} model is missing from the container")

        try:
            import ncnn
            from rife_ncnn_vulkan_python import Rife
        except ImportError as exc:  # pragma: no cover
            raise EngineError("the RIFE Vulkan runtime is not installed in this container") from exc

        gpu_count = ncnn.get_gpu_count()
        if mode == "gpu" and gpu_count <= 0:
            raise EngineError("GPU-only mode requires a working Vulkan device")
        gpuid = config.GPU_DEVICE if gpu_count > 0 and mode != "cpu" else -1
        self.backend = "vulkan" if gpuid >= 0 else "cpu-ncnn"
        try:
            self._rife = Rife(gpuid=gpuid, model=str(model_dir), num_threads=self.threads)
        except Exception as exc:
            raise EngineError(f"could not load {spec.label} on Vulkan: {exc}") from exc
        log.info("loaded %s on %s (%s)", spec.label, self.backend, spec.model_dir)

    @staticmethod
    def _signature(frame: np.ndarray) -> np.ndarray:
        small = cv2.resize(frame, (64, 36), interpolation=cv2.INTER_AREA)
        return cv2.cvtColor(small, cv2.COLOR_RGB2GRAY).astype(np.float32) / 255.0

    def is_scene_cut(self, a: np.ndarray, b: np.ndarray) -> bool:
        return float(np.mean(np.abs(self._signature(a) - self._signature(b)))) > SCENE_CUT_THRESHOLD

    def generate(self, a: np.ndarray, b: np.ndarray, factor: int) -> list[np.ndarray]:
        if factor < 2:
            return []
        if a.shape != b.shape:
            raise EngineError("interpolation requires frames of equal size")
        if self.is_scene_cut(a, b):
            return [a.copy() for _ in range(factor - 1)]

        height, width = a.shape[:2]
        working_h = height
        working_w = width
        if self.max_height and height > self.max_height:
            ratio = self.max_height / float(height)
            working_h = max(2, int(round(height * ratio)))
            working_w = max(2, int(round(width * ratio)))

        a_bgr = cv2.cvtColor(a, cv2.COLOR_RGB2BGR)
        b_bgr = cv2.cvtColor(b, cv2.COLOR_RGB2BGR)
        if working_h != height or working_w != width:
            a_bgr = cv2.resize(a_bgr, (working_w, working_h), interpolation=cv2.INTER_AREA)
            b_bgr = cv2.resize(b_bgr, (working_w, working_h), interpolation=cv2.INTER_AREA)

        output: list[np.ndarray] = []
        try:
            for index in range(1, factor):
                mid = self._rife.process_cv2(a_bgr, b_bgr, index / float(factor))
                if mid is None:
                    raise EngineError(f"{self.spec.label} returned no frame")
                if working_h != height or working_w != width:
                    mid = cv2.resize(mid, (width, height), interpolation=cv2.INTER_LANCZOS4)
                output.append(cv2.cvtColor(mid, cv2.COLOR_BGR2RGB))
        except EngineError:
            raise
        except Exception as exc:
            raise EngineError(f"{self.spec.label} inference failed: {exc}") from exc
        return output
