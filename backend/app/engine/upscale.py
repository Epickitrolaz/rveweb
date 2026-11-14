"""Real-ESRGAN upscaling through ncnn's Vulkan backend, with a CPU fallback."""

from __future__ import annotations

import logging
from pathlib import Path

import cv2
import numpy as np

from .. import config
from ..catalog import UPSCALERS, upscaler_model_id
from .ffmpeg import EngineError

log = logging.getLogger(__name__)


class Upscaler:
    def __init__(self, model_id: str, scale: int) -> None:
        spec = UPSCALERS.get(model_id)
        if spec is None:
            raise EngineError(f"unknown upscaling model: {model_id}")
        if scale not in spec.scales:
            raise EngineError(f"{model_id} does not support {scale}x")
        self.spec = spec
        self.scale = scale
        self.native_scale = spec.native_scale or scale
        self.model_name = upscaler_model_id(spec, scale)
        self.mode = "lanczos"
        self._net = None
        self._ncnn = None
        self._load_error: str | None = None
        self._init_ncnn()

    def _init_ncnn(self) -> None:
        param_path = config.MODEL_DIR / "upscalers" / f"{self.model_name}.param"
        bin_path = config.MODEL_DIR / "upscalers" / f"{self.model_name}.bin"
        if not param_path.exists() or not bin_path.exists():
            raise EngineError(f"the {self.spec.label} model is missing from the container")
        try:
            import ncnn
        except ImportError:
            self._load_error = "ncnn python bindings are not installed"
            log.warning("upscaler falling back to Lanczos: %s", self._load_error)
            return
        try:
            gpu_count = ncnn.get_gpu_count()
        except Exception:
            gpu_count = 0
        if gpu_count <= 0:
            self._load_error = "no Vulkan device found"
            log.warning("upscaler falling back to Lanczos: %s", self._load_error)
            return

        try:
            net = ncnn.Net()
            net.opt.use_vulkan_compute = True
            net.opt.use_fp16_packed = False
            net.opt.use_fp16_storage = False
            net.opt.use_int8_storage = False
            net.opt.use_int8_packed = False
            net.opt.num_threads = max(1, config.RIFE_THREADS)
            net.set_vulkan_device(config.GPU_DEVICE)
            net.load_param(str(param_path))
            net.load_model(str(bin_path))
        except Exception as exc:
            self._load_error = str(exc)
            log.warning("upscaler falling back to Lanczos: %s", exc)
            return

        self._ncnn = ncnn
        self._net = net
        self.mode = "vulkan"
        log.info("upscaler ready: %s (%s, Vulkan device %d)", self.model_name, self.spec.label, config.GPU_DEVICE)

    # ------------------------------------------------------------------ tiles

    def _infer_tile(self, tile_rgb: np.ndarray) -> np.ndarray:
        assert self._net is not None and self._ncnn is not None
        ncnn = self._ncnn
        height, width = tile_rgb.shape[:2]
        mat = ncnn.Mat.from_pixels(
            np.ascontiguousarray(tile_rgb), ncnn.Mat.PixelType.PIXEL_RGB, width, height
        )
        mat.substract_mean_normalize([], [1 / 255.0, 1 / 255.0, 1 / 255.0])
        extractor = self._net.create_extractor()
        extractor.input("data", mat)
        code, output = extractor.extract("output")
        if code != 0:
            raise EngineError(f"ncnn inference failed (code {code})")
        array = np.array(output).transpose(1, 2, 0).astype(np.float32)
        if array.size == 0:
            raise EngineError("ncnn returned an empty frame")
        if float(array.max()) <= 1.5:
            array *= 255.0
        return np.ascontiguousarray(np.clip(array, 0, 255), dtype=np.uint8)

    def _upscale_native(self, frame: np.ndarray) -> np.ndarray:
        height, width = frame.shape[:2]
        scale = self.native_scale
        output = np.empty((height * scale, width * scale, 3), dtype=np.uint8)
        tile_size = self.spec.tile
        pad = max(8, tile_size // 16)

        for y0 in range(0, height, tile_size):
            y1 = min(y0 + tile_size, height)
            for x0 in range(0, width, tile_size):
                x1 = min(x0 + tile_size, width)
                px0, px1 = max(0, x0 - pad), min(width, x1 + pad)
                py0, py1 = max(0, y0 - pad), min(height, y1 + pad)
                tile = frame[py0:py1, px0:px1]
                upscaled = self._infer_tile(tile)
                left = (x0 - px0) * scale
                top = (y0 - py0) * scale
                crop_w = (x1 - x0) * scale
                crop_h = (y1 - y0) * scale
                output[y0 * scale:y1 * scale, x0 * scale:x1 * scale] = upscaled[
                    top:top + crop_h, left:left + crop_w
                ]
        return output

    # ----------------------------------------------------------------- public

    def upscale(self, frame: np.ndarray) -> np.ndarray:
        height, width = frame.shape[:2]
        target_w = max(2, ((width * self.scale + 1) // 2) * 2)
        target_h = max(2, ((height * self.scale + 1) // 2) * 2)

        if self._net is None:
            return cv2.resize(frame, (target_w, target_h), interpolation=cv2.INTER_LANCZOS4)

        native = self._upscale_native(frame)
        if native.shape[1] == target_w and native.shape[0] == target_h:
            return native
        return cv2.resize(native, (target_w, target_h), interpolation=cv2.INTER_AREA)
