"""Application configuration, loaded from the environment."""

from __future__ import annotations

import os
import shutil
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent.parent  # backend/ in dev, /app in Docker
REPO_DIR = APP_DIR.parent


def _env_path(name: str, default: Path) -> Path:
    value = os.environ.get(name)
    return Path(value).expanduser().resolve() if value else default


def _env_int(name: str, default: int, minimum: int = 0) -> int:
    try:
        return max(minimum, int(os.environ.get(name, default)))
    except (TypeError, ValueError):
        return default


def _env_float(name: str, default: float, minimum: float = 0.0) -> float:
    try:
        return max(minimum, float(os.environ.get(name, default)))
    except (TypeError, ValueError):
        return default


VERSION = "1.0.0"

DATA_DIR = _env_path("DATA_DIR", APP_DIR / "data")
MODEL_DIR = _env_path("MODEL_DIR", APP_DIR / "models")
FRONTEND_DIR = _env_path("FRONTEND_DIR", REPO_DIR / "frontend")

FFMPEG_PATH = os.environ.get("FFMPEG_PATH") or shutil.which("ffmpeg") or "/usr/bin/ffmpeg"
FFPROBE_PATH = os.environ.get("FFPROBE_PATH") or shutil.which("ffprobe") or "/usr/bin/ffprobe"

MAX_ACTIVE_JOBS = _env_int("MAX_ACTIVE_JOBS", 1, 1)
MAX_QUEUE = _env_int("MAX_QUEUE", 25, 1)
MAX_UPLOAD_MB = _env_int("MAX_UPLOAD_MB", 1024, 1)
MAX_INFLIGHT_UPLOADS = _env_int("MAX_INFLIGHT_UPLOADS", 3, 1)
MIN_FREE_GB = _env_float("MIN_FREE_GB", 3.0, 0.0)
RETENTION_HOURS = _env_int("RETENTION_HOURS", 72, 1)

JOB_TIMEOUT_MIN = _env_int("JOB_TIMEOUT_MIN", 900, 60)
JOB_TIMEOUT_MAX = _env_int("JOB_TIMEOUT_MAX", 10800, 60)
JOB_TIMEOUT_PER_SECOND = _env_int("JOB_TIMEOUT_PER_SECOND", 240, 0)

RIFE_THREADS = _env_int("RIFE_THREADS", max(1, min(4, os.cpu_count() or 2)), 1)
FFMPEG_THREADS = _env_int("FFMPEG_THREADS", 2, 1)
GPU_DEVICE = _env_int("GPU_DEVICE", 0, 0)
LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()

MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024
ALLOWED_EXTENSIONS = {
    ".mp4", ".m4v", ".mkv", ".mov", ".webm", ".avi", ".wmv", ".flv",
    ".mpg", ".mpeg", ".ts", ".m2ts", ".ogv", ".3gp",
}

JOBS_DIR = DATA_DIR / "jobs"
LOG_DIR = DATA_DIR / "logs"

for directory in (DATA_DIR, JOBS_DIR, LOG_DIR):
    directory.mkdir(parents=True, exist_ok=True)
