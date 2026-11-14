"""Request validation for job settings."""

from __future__ import annotations

import json
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .catalog import INTERPOLATORS, UPSCALERS


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class UpscaleSettings(StrictModel):
    enabled: bool = True
    model: Literal["realesrgan-video", "realesrgan-x4plus", "realesrgan-x4plus-anime"] = "realesrgan-video"
    scale: Literal[2, 3, 4] = 2

    @model_validator(mode="after")
    def _scale_supported(self) -> "UpscaleSettings":
        if self.scale not in UPSCALERS[self.model].scales:
            raise ValueError(f"scale {self.scale}x is not available for {self.model}")
        return self


class InterpolateSettings(StrictModel):
    enabled: bool = True
    model: Literal["rife-4.27", "rife-4.27-s"] = "rife-4.27"
    factor: Literal[2, 4, 8] = 2
    maxHeight: Literal[0, 480, 720, 1080, 2160] = 1080

    @model_validator(mode="after")
    def _factor_supported(self) -> "InterpolateSettings":
        if self.factor not in INTERPOLATORS[self.model].factors:
            raise ValueError(f"{self.factor}x is not available for {self.model}")
        return self


class DenoiseSettings(StrictModel):
    enabled: bool = False
    strength: Literal["light", "medium", "strong"] = "medium"


class DecompressSettings(StrictModel):
    enabled: bool = False
    strength: Literal["light", "strong"] = "light"


class EncodeSettings(StrictModel):
    codec: Literal["h264", "h265"] = "h264"
    crf: int = Field(default=18, ge=14, le=28)
    preset: Literal["veryfast", "fast", "medium"] = "veryfast"
    container: Literal["mp4", "mkv"] = "mp4"


class AudioSettings(StrictModel):
    mode: Literal["copy", "none"] = "copy"


class JobSettings(StrictModel):
    upscale: UpscaleSettings = Field(default_factory=UpscaleSettings)
    interpolate: InterpolateSettings = Field(default_factory=InterpolateSettings)
    denoise: DenoiseSettings = Field(default_factory=DenoiseSettings)
    decompress: DecompressSettings = Field(default_factory=DecompressSettings)
    encode: EncodeSettings = Field(default_factory=EncodeSettings)
    audio: AudioSettings = Field(default_factory=AudioSettings)


def parse_settings(raw: str | None) -> JobSettings:
    if raw is None or not raw.strip():
        raise ValueError("settings field is required")
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"settings is not valid JSON: {exc.msg}") from exc
    if not isinstance(data, dict):
        raise ValueError("settings must be a JSON object")
    try:
        return JobSettings.model_validate(data)
    except Exception as exc:  # pydantic ValidationError
        message = str(exc)
        if len(message) > 600:
            message = message[:600] + "…"
        raise ValueError(f"invalid settings: {message}") from exc
