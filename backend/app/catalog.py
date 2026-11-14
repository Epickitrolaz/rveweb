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
    engine: str = "ncnn"  # ncnn | cpu


@dataclass(frozen=True)
class InterpolatorSpec:
    id: str
    label: str
    note: str
    factors: tuple[int, ...]
    engine: str  # onnx | ncnn
    backend: str  # cpu | gpu
    onnx_file: str = ""
    model_dir: str = ""


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
    "lanczos": UpscalerSpec(
        id="lanczos",
        label="Lanczos · CPU",
        note="Fast CPU scaling, no AI",
        scales=(2, 3, 4),
        native_scale=0,
        tile=0,
        engine="cpu",
    ),
}

INTERPOLATORS: dict[str, InterpolatorSpec] = {
    "rife-4.27": InterpolatorSpec(
        id="rife-4.27", label="RIFE 4.27", note="Quality · ONNX (CPU/CUDA)",
        factors=(2, 4, 8), engine="onnx", backend="cpu", onnx_file="RIFE_fp32.onnx",
    ),
    "rife-4.27-s": InterpolatorSpec(
        id="rife-4.27-s", label="RIFE 4.27 Small", note="Lighter · ONNX (CPU/CUDA)",
        factors=(2, 4, 8), engine="onnx", backend="cpu", onnx_file="RIFE_s_fp32.onnx",
    ),
    "rife-4.26": InterpolatorSpec(
        id="rife-4.26", label="RIFE 4.26", note="Vulkan · GPU",
        factors=(2, 4, 8), engine="ncnn", backend="gpu", model_dir="rife-v4.26",
    ),
    "rife-4.25": InterpolatorSpec(
        id="rife-4.25", label="RIFE 4.25", note="Vulkan · GPU",
        factors=(2, 4, 8), engine="ncnn", backend="gpu", model_dir="rife-v4.25",
    ),
    "rife-4.22": InterpolatorSpec(
        id="rife-4.22", label="RIFE 4.22", note="Vulkan · GPU",
        factors=(2, 4, 8), engine="ncnn", backend="gpu", model_dir="rife-v4.22",
    ),
    "rife-4.18": InterpolatorSpec(
        id="rife-4.18", label="RIFE 4.18", note="Vulkan · GPU",
        factors=(2, 4, 8), engine="ncnn", backend="gpu", model_dir="rife-v4.18",
    ),
    "rife-4.15": InterpolatorSpec(
        id="rife-4.15", label="RIFE 4.15", note="Vulkan · GPU",
        factors=(2, 4, 8), engine="ncnn", backend="gpu", model_dir="rife-v4.15",
    ),
    "rife-4.12": InterpolatorSpec(
        id="rife-4.12", label="RIFE 4.12", note="Vulkan · GPU",
        factors=(2, 4, 8), engine="ncnn", backend="gpu", model_dir="rife-v4.12",
    ),
    "rife-4.7": InterpolatorSpec(
        id="rife-4.7", label="RIFE 4.7", note="Vulkan · GPU",
        factors=(2, 4, 8), engine="ncnn", backend="gpu", model_dir="rife-v4.7",
    ),
    "rife-4.6": InterpolatorSpec(
        id="rife-4.6", label="RIFE 4.6", note="Vulkan · GPU",
        factors=(2, 4, 8), engine="ncnn", backend="gpu", model_dir="rife-v4.6",
    ),
}


def upscaler_model_id(spec: UpscalerSpec, requested_scale: int) -> str:
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
                "engine": spec.engine,
            }
            for spec in UPSCALERS.values()
        ],
        "interpolators": [
            {
                "id": spec.id,
                "label": spec.label,
                "factors": list(spec.factors),
                "note": spec.note,
                "engine": spec.engine,
                "backend": spec.backend,
            }
            for spec in INTERPOLATORS.values()
        ],
    }
