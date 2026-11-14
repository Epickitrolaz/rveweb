"""The streaming enhancement pipeline: decode, restore, interpolate, upscale, encode."""

from __future__ import annotations

import logging
import os
import threading
import time
from pathlib import Path
from typing import Callable

import numpy as np

from ..schemas import JobSettings
from .ffmpeg import (
    EngineError,
    Process,
    build_decode_command,
    build_encode_command,
    mux_audio,
    probe_video,
)
from ..catalog import INTERPOLATORS
from .rife import RifeInterpolator
from .rife_ncnn import RifeNcnnInterpolator
from .upscale import Upscaler

log = logging.getLogger(__name__)


class Cancelled(Exception):
    """Raised when the user cancels a job."""


ProgressCallback = Callable[[float, str, int | None], None]
CancelCallback = Callable[[], bool]


def _even(value: int) -> int:
    return max(2, ((value + 1) // 2) * 2)


class Pipeline:
    def __init__(
        self,
        *,
        input_path: str,
        output_path: str,
        settings: JobSettings,
        source: dict,
        progress: ProgressCallback,
        cancelled: CancelCallback,
    ) -> None:
        self.input_path = input_path
        self.output_path = output_path
        self.settings = settings
        self.source = source
        self.progress = progress
        self.cancelled = cancelled

        self.width = int(source["width"])
        self.height = int(source["height"])
        self.source_fps = float(source["fps"])
        self.has_audio = bool(source.get("hasAudio"))
        self.total_input = max(1, int(source.get("frameCount") or 1))

        self.factor = settings.interpolate.factor if settings.interpolate.enabled else 1
        self.scale = settings.upscale.scale if settings.upscale.enabled else 1
        self.out_fps = self.source_fps * self.factor
        if settings.upscale.enabled:
            self.out_width = _even(self.width * self.scale)
            self.out_height = _even(self.height * self.scale)
        else:
            self.out_width = self.width
            self.out_height = self.height

        self.decode: Process | None = None
        self.encode: Process | None = None
        self.interpolator: RifeInterpolator | None = None
        self.upscaler: Upscaler | None = None

        self.source_frames = 0
        self.output_frames = 0
        self.last_progress = -1.0
        self.last_progress_at = 0.0
        self.started_at = time.monotonic()
        self.stage = "denoise" if (settings.denoise.enabled or settings.decompress.enabled) else "decode"

    # ----------------------------------------------------------------- helpers

    def _check_cancel(self) -> None:
        try:
            if self.cancelled():
                raise Cancelled()
        except Cancelled:
            raise
        except Exception:
            log.debug("cancel check failed", exc_info=True)

    def _report(self, fraction: float, stage: str | None = None, force: bool = False) -> None:
        fraction = min(1.0, max(0.01, fraction))
        now = time.monotonic()
        if not force and now - self.last_progress_at < 0.7 and fraction - self.last_progress < 0.01:
            return
        if self.stage != (stage or self.stage):
            self.stage = stage or self.stage
        elapsed = now - self.started_at
        eta = None
        if fraction > 0.06 and elapsed > 3:
            eta = int(max(0, elapsed * (1.0 - fraction) / fraction))
        self.last_progress = fraction
        self.last_progress_at = now
        self.progress(fraction, self.stage, eta)

    def _emit(self, frame: np.ndarray) -> None:
        assert self.encode is not None
        if self.upscaler is not None:
            frame = self.upscaler.upscale(frame)
        self.encode.write(np.ascontiguousarray(frame).tobytes())
        self.output_frames += 1
        if self.output_frames % 8 == 0:
            self._check_cancel()
            source_fraction = min(1.0, self.source_frames / self.total_input)
            self._report(0.05 + 0.82 * source_fraction)

    # -------------------------------------------------------------------- run

    def run(self) -> dict:
        settings = self.settings
        log.info(
            "pipeline start: %dx%d %.3ffps %s | upscale=%s/%s interp=%s/%s denoise=%s decompress=%s",
            self.width, self.height, self.source_fps, self.source.get("codec"),
            settings.upscale.model if settings.upscale.enabled else "off",
            settings.upscale.scale if settings.upscale.enabled else "-",
            settings.interpolate.model if settings.interpolate.enabled else "off",
            settings.interpolate.factor if settings.interpolate.enabled else "-",
            settings.denoise.enabled, settings.decompress.enabled,
        )
        self._report(0.02, self.stage, force=True)

        if settings.interpolate.enabled:
            mode = settings.processing.mode
            spec = INTERPOLATORS[settings.interpolate.model]
            if spec.engine == "ncnn":
                self.interpolator = RifeNcnnInterpolator(
                    settings.interpolate.model,
                    mode=mode,
                    max_height=settings.interpolate.maxHeight,
                )
            else:
                if mode == "gpu":
                    raise EngineError(
                        "GPU-only mode cannot use RIFE 4.27 (ONNX CPU). "
                        "Choose RIFE 4.26 or older, or switch to Auto."
                    )
                self.interpolator = RifeInterpolator(
                    settings.interpolate.model,
                    mode=mode,
                    max_height=settings.interpolate.maxHeight,
                )
        if settings.upscale.enabled:
            self.upscaler = Upscaler(
                settings.upscale.model, settings.upscale.scale, settings.processing.mode
            )

        frame_bytes = self.width * self.height * 3
        temp_dir = Path(self.output_path).parent
        suffix = settings.encode.container
        temp_video = str(temp_dir / f"video-only.{suffix}")

        self.decode = Process(build_decode_command(self.input_path, settings), want_stdin=False, want_stdout=True)
        self.encode = Process(
            build_encode_command(self.out_width, self.out_height, self.out_fps, settings, temp_video),
            want_stdin=True,
            want_stdout=False,
        )

        try:
            first_raw = self.decode.read_exact(frame_bytes)
            if first_raw is None:
                raise EngineError(self.decode.describe_failure("could not decode the first frame"))
            first = np.frombuffer(first_raw, dtype=np.uint8).reshape(self.height, self.width, 3)
            self.source_frames = 1
            self._emit(first)  # type: ignore[arg-type]
            previous = first

            self.stage = "interpolate" if self.interpolator else ("upscale" if self.upscaler else "encode")
            self._report(0.06, self.stage, force=True)

            while True:
                raw = self.decode.read_exact(frame_bytes)
                if raw is None:
                    break
                current = np.frombuffer(raw, dtype=np.uint8).reshape(self.height, self.width, 3)
                self.source_frames += 1
                if self.interpolator is not None:
                    mids = self.interpolator.generate(previous, current, self.factor)  # type: ignore[arg-type]
                    for mid in mids:
                        self._emit(mid)
                self._emit(current)  # type: ignore[arg-type]
                previous = current
                if self.source_frames % 4 == 0:
                    self._check_cancel()
                    self._report(0.05 + 0.82 * min(1.0, self.source_frames / self.total_input))

            # Hold the last frame so the output duration and fps stay exact.
            if self.factor > 1:
                for _ in range(self.factor - 1):
                    self._emit(previous)

            self.decode.close_stdin()
            decode_code = self.decode.wait(timeout=300)
            if decode_code != 0:
                raise EngineError(self.decode.describe_failure("video decoding failed"))

            self._report(0.9, "encode", force=True)
            self.encode.close_stdin()
            encode_code = self.encode.wait(timeout=3600)
            if encode_code != 0:
                raise EngineError(self.encode.describe_failure("video encoding failed"))

            self._report(0.95, "finalize", force=True)
            mux_audio(
                temp_video,
                self.input_path,
                self.output_path,
                settings,
                has_audio=self.has_audio and settings.audio.mode != "none",
            )
            self._report(0.99, "finalize", force=True)

            info = probe_video(self.output_path)
            info["frameCount"] = self.output_frames
            info["engine"] = {
                "mode": settings.processing.mode,
                "upscaler": self.upscaler.mode if self.upscaler else "off",
                "interpolation": (
                    "off" if not self.interpolator
                    else getattr(self.interpolator, "backend", "cpu-onnx")
                ),
            }
            self._report(1.0, "done", force=True)
            log.info(
                "pipeline done: %d source frames -> %d output frames, %dx%d @ %.3ffps",
                self.source_frames, self.output_frames, info["width"], info["height"], info["fps"],
            )
            return info
        except BaseException:
            self._terminate()
            raise
        finally:
            for path in (temp_video,):
                try:
                    os.unlink(path)
                except OSError:
                    pass

    def _terminate(self) -> None:
        for process in (self.encode, self.decode):
            if process is not None:
                process.terminate()
