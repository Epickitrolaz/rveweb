"""Request validation for job settings."""

from __future__ import annotations

import json
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .catalog import INTERPOLATORS, UPSCALERS


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class UpscaleSettings(StrictModel):
    enabled: bool = True
    model: str = "realesrgan-video"
    scale: Literal[2, 3, 4] = 2

    @field_validator("model")
    @classmethod
    def _known_model(cls, value: str) -> str:
        if value not in UPSCALERS:
            raise ValueError(f"unknown upscaling model: {value}")
        return value

    @model_validator(mode="after")
    def _scale_supported(self) -> "UpscaleSettings":
        if self.scale not in UPSCALERS[self.model].scales:
            raise ValueError(f"scale {self.scale}x is not available for {self.model}")
        return self


class InterpolateSettings(StrictModel):
    enabled: bool = True
    model: str = "rife-4.27"
    factor: Literal[2, 4, 8] = 2
    maxHeight: Literal[0, 480, 720, 1080, 2160] = 1080

    @field_validator("model")
    @classmethod
    def _known_model(cls, value: str) -> str:
        if value not in INTERPOLATORS:
            raise ValueError(f"unknown interpolation model: {value}")
        return value

    @model_validator(mode="after")
    def _factor_supported(self) -> "InterpolateSettings":
        if self.factor not in INTERPOLATORS[self.model].factors:
            raise ValueError(f"{self.factor}x is not available for {self.model}")
        return self


class ProcessingSettings(StrictModel):
    mode: Literal["auto", "gpu", "cpu"] = "auto"


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
    processing: ProcessingSettings = Field(default_factory=ProcessingSettings)
    upscale: UpscaleSettings = Field(default_factory=UpscaleSettings)
    interpolate: InterpolateSettings = Field(default_factory=InterpolateSettings)
    denoise: DenoiseSettings = Field(default_factory=DenoiseSettings)
    decompress: DecompressSettings = Field(default_factory=DecompressSettings)
    encode: EncodeSettings = Field(default_factory=EncodeSettings)
    audio: AudioSettings = Field(default_factory=AudioSettings)


class StationDefaults(StrictModel):
    encode: EncodeSettings = Field(default_factory=EncodeSettings)
    audio: AudioSettings = Field(default_factory=AudioSettings)


class StationSettingsUpdate(StrictModel):
    processingMode: Literal["auto", "gpu", "cpu"] = "auto"
    defaults: StationDefaults = Field(default_factory=StationDefaults)


class LibraryActivate(StrictModel):
    versionId: str


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
    except Exception as exc:
        message = str(exc)
        if len(message) > 600:
            message = message[:600] + "…"
        raise ValueError(f"invalid settings: {message}") from exc
