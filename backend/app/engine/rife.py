"""RIFE 4.27 frame interpolation on ONNX Runtime.

The 4.27 model is a 2-frame IFNet exported by FluidFrames. It takes the two RGB/BGR
frames concatenated on the channel axis and returns one midpoint frame. Recursive
bisection produces 2x/4x/8x frame counts. The model has no timestep input, which is why
bisection (rather than arbitrary timesteps) is the correct way to place intermediate
frames evenly.
"""

from __future__ import annotations

import logging
import time
from pathlib import Path

import cv2
import numpy as np

from .. import config
from ..catalog import INTERPOLATORS
from .ffmpeg import EngineError

log = logging.getLogger(__name__)

SCENE_CUT_THRESHOLD = 0.20


class RifeInterpolator:
    def __init__(self, model_id: str, *, max_height: int = 0, threads: int | None = None) -> None:
        spec = INTERPOLATORS.get(model_id)
        if spec is None:
            raise EngineError(f"unknown interpolation model: {model_id}")
        self.spec = spec
        self.max_height = max_height
        self.threads = threads or config.RIFE_THREADS
        self._session = None
        self._input_name: str | None = None
        self._warm = False

    # ------------------------------------------------------------------ model

    def _load(self) -> None:
        if self._session is not None:
            return
        model_path = config.MODEL_DIR / "rife" / self.spec.onnx_file
        if not model_path.exists():
            raise EngineError(
                f"the {self.spec.label} model is missing from the container ({model_path.name})"
            )
        try:
            import onnxruntime as ort
        except ImportError as exc:  # pragma: no cover - image build guarantees this
            raise EngineError("onnxruntime is not installed in this container") from exc

        options = ort.SessionOptions()
        options.intra_op_num_threads = max(1, self.threads)
        options.inter_op_num_threads = 1
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        options.enable_mem_pattern = True
        options.enable_cpu_mem_arena = True

        started = time.monotonic()
        try:
            self._session = ort.InferenceSession(
                str(model_path),
                sess_options=options,
                providers=["CPUExecutionProvider"],
            )
        except Exception as exc:
            raise EngineError(f"could not load the {self.spec.label} model: {exc}") from exc
        self._input_name = self._session.get_inputs()[0].name
        log.info(
            "loaded %s in %.1fs (%d threads, CPU ONNX)",
            self.spec.label,
            time.monotonic() - started,
            self.threads,
        )

    def _infer(self, a_bgr: np.ndarray, b_bgr: np.ndarray) -> np.ndarray:
        assert self._session is not None and self._input_name is not None
        combined = np.concatenate((a_bgr, b_bgr), axis=2).astype(np.float32) / 255.0
        tensor = np.ascontiguousarray(combined.transpose(2, 0, 1)[None, ...])
        try:
            output = self._session.run(None, {self._input_name: tensor})[0]
        except Exception as exc:
            raise EngineError(f"{self.spec.label} inference failed: {exc}") from exc
        frame = np.squeeze(output, axis=0).transpose(1, 2, 0)
        frame = np.clip(frame, 0.0, 1.0) * 255.0
        return np.ascontiguousarray(frame, dtype=np.uint8)

    def _bisect(self, a: np.ndarray, b: np.ndarray, depth: int) -> list[np.ndarray]:
        if depth == 0:
            return []
        mid = self._infer(a, b)
        return self._bisect(a, mid, depth - 1) + [mid] + self._bisect(mid, b, depth - 1)

    # --------------------------------------------------------------- pipeline

    @staticmethod
    def _signature(frame: np.ndarray) -> np.ndarray:
        small = cv2.resize(frame, (64, 36), interpolation=cv2.INTER_AREA)
        gray = cv2.cvtColor(small, cv2.COLOR_RGB2GRAY).astype(np.float32) / 255.0
        return gray

    def is_scene_cut(self, a: np.ndarray, b: np.ndarray) -> bool:
        return float(np.mean(np.abs(self._signature(a) - self._signature(b)))) > SCENE_CUT_THRESHOLD

    def generate(self, a: np.ndarray, b: np.ndarray, factor: int) -> list[np.ndarray]:
        """Return factor-1 frames between a and b, at the source resolution."""
        if factor < 2:
            return []
        if a.shape != b.shape:
            raise EngineError("interpolation requires frames of equal size")
        self._load()
        assert self._session is not None

        if self.is_scene_cut(a, b):
            return [a.copy() for _ in range(factor - 1)]

        height, width = a.shape[:2]
        working_h = height
        working_w = width
        if self.max_height and height > self.max_height:
            scale = self.max_height / float(height)
            working_h = max(2, int(round(height * scale)))
            working_w = max(2, int(round(width * scale)))

        # FluidFrames feeds OpenCV frames (BGR) to the ONNX model, so match it exactly.
        a_bgr = cv2.cvtColor(a, cv2.COLOR_RGB2BGR)
        b_bgr = cv2.cvtColor(b, cv2.COLOR_RGB2BGR)
        if working_h != height or working_w != width:
            a_work = cv2.resize(a_bgr, (working_w, working_h), interpolation=cv2.INTER_AREA)
            b_work = cv2.resize(b_bgr, (working_w, working_h), interpolation=cv2.INTER_AREA)
        else:
            a_work, b_work = a_bgr, b_bgr

        depth = {2: 1, 4: 2, 8: 3}[factor]
        mids_bgr = self._bisect(a_work, b_work, depth)
        self._warm = True

        output: list[np.ndarray] = []
        for frame in mids_bgr:
            if working_h != height or working_w != width:
                frame = cv2.resize(frame, (width, height), interpolation=cv2.INTER_LANCZOS4)
            output.append(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
        return output
