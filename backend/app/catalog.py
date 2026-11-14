"""Model catalog shared by the API, the UI, and the engine."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class UpscalerSpec:
    id: str
    label: str
    note: str
    scales: tuple[int, ...]
    native_scale: int
    tile: int


@dataclass(frozen=True)
class InterpolatorSpec:
    id: str
    label: str
    note: str
    factors: tuple[int, ...]
    onnx_file: str


UPSCALERS: dict[str, UpscalerSpec] = {
    "realesrgan-video": UpscalerSpec(
        id="realesrgan-video",
        label="Real-ESRGAN v3 · Video",
        note="Fast, video-tuned",
        scales=(2, 3, 4),
        native_scale=0,
        tile=256,
    ),
    "realesrgan-x4plus": UpscalerSpec(
        id="realesrgan-x4plus",
        label="Real-ESRGAN x4plus · Detail",
        note="Slow, maximum detail",
        scales=(2, 4),
        native_scale=4,
        tile=192,
    ),
    "realesrgan-x4plus-anime": UpscalerSpec(
        id="realesrgan-x4plus-anime",
        label="Real-ESRGAN x4plus Anime",
        note="Animation line art",
        scales=(2, 4),
        native_scale=4,
        tile=224,
    ),
}

INTERPOLATORS: dict[str, InterpolatorSpec] = {
    "rife-4.27": InterpolatorSpec(
        id="rife-4.27",
        label="RIFE 4.27",
        note="Quality",
        factors=(2, 4, 8),
        onnx_file="RIFE_fp32.onnx",
    ),
    "rife-4.27-s": InterpolatorSpec(
        id="rife-4.27-s",
        label="RIFE 4.27 Small",
        note="Faster, lighter",
        factors=(2, 4, 8),
        onnx_file="RIFE_s_fp32.onnx",
    ),
}


def upscaler_model_id(spec: UpscalerSpec, requested_scale: int) -> str:
    """Return the model identifier to load for a requested output scale."""
    if spec.id == "realesrgan-video":
        return f"realesr-animevideov3-x{requested_scale}"
    return spec.id


def model_catalog() -> dict:
    return {
        "upscalers": [
            {
                "id": spec.id,
                "label": spec.label,
                "scales": list(spec.scales),
                "note": spec.note,
            }
            for spec in UPSCALERS.values()
        ],
        "interpolators": [
            {
                "id": spec.id,
                "label": spec.label,
                "factors": list(spec.factors),
                "note": spec.note,
            }
            for spec in INTERPOLATORS.values()
        ],
    }
