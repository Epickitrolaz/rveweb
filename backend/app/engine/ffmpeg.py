"""ffmpeg/ffprobe helpers and subprocess plumbing."""

from __future__ import annotations

import json
import logging
import os
import shlex
import subprocess
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any, Sequence

from .. import config
from ..schemas import JobSettings

log = logging.getLogger(__name__)

MAX_INPUT_WIDTH = 4096
MAX_INPUT_HEIGHT = 4096
MAX_INPUT_DURATION = 4 * 3600


class EngineError(RuntimeError):
    """A failure that is safe to show to the user."""


class ProbeError(EngineError):
    pass


def _run(args: Sequence[str], timeout: float = 60) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            list(args),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise EngineError(f"ffmpeg command timed out after {int(timeout)}s") from exc
    except FileNotFoundError as exc:
        raise EngineError("ffmpeg is not installed in this container") from exc


def _rate(value: str | None) -> float:
    if not value:
        return 0.0
    try:
        if "/" in value:
            num, den = value.split("/", 1)
            denominator = float(den)
            return float(num) / denominator if denominator else 0.0
        return float(value)
    except (TypeError, ValueError, ZeroDivisionError):
        return 0.0


def probe_video(path: str | Path) -> dict[str, Any]:
    """Return normalized metadata for the first video stream."""
    result = _run(
        [
            config.FFPROBE_PATH,
            "-v", "error",
            "-print_format", "json",
            "-show_streams",
            "-show_format",
            str(path),
        ],
        timeout=45,
    )
    if result.returncode != 0:
        detail = (result.stderr or "").strip().splitlines()
        message = detail[-1] if detail else "unknown ffprobe error"
        message = message.replace(f"{path}: ", "")
        raise ProbeError(f"could not read this video: {message}")

    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise ProbeError("ffprobe returned unreadable metadata") from exc

    streams = data.get("streams") or []
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    if video is None:
        raise ProbeError("this file has no video stream")

    width = int(video.get("width") or 0)
    height = int(video.get("height") or 0)
    fps = _rate(video.get("avg_frame_rate")) or _rate(video.get("r_frame_rate"))
    if width <= 0 or height <= 0:
        raise ProbeError("this video has no usable resolution")
    if fps <= 0 or fps > 480:
        raise ProbeError("this video has an unsupported frame rate")

    rotation = 0
    for side_data in video.get("side_data_list") or []:
        if "rotation" in side_data:
            try:
                rotation = int(float(side_data["rotation"]))
            except (TypeError, ValueError):
                rotation = 0
    if abs(rotation) % 180 == 90:
        width, height = height, width

    fmt = data.get("format") or {}
    duration = 0.0
    for candidate in (video.get("duration"), fmt.get("duration")):
        try:
            duration = float(candidate)
        except (TypeError, ValueError):
            continue
        if duration > 0:
            break
    if duration <= 0:
        raise ProbeError("this video has no readable duration")
    if duration > MAX_INPUT_DURATION:
        raise ProbeError("this video is longer than the 4 hour limit")

    frame_count = 0
    try:
        frame_count = int(video.get("nb_frames") or 0)
    except (TypeError, ValueError):
        frame_count = 0
    if frame_count <= 0:
        frame_count = max(1, round(duration * fps))

    if width > MAX_INPUT_WIDTH or height > MAX_INPUT_HEIGHT:
        raise ProbeError(
            f"resolution {width}×{height} is above the {MAX_INPUT_WIDTH}×{MAX_INPUT_HEIGHT} limit"
        )
    if width * height > 3840 * 2160:
        raise ProbeError("this resolution is too large for the enhancement pipeline (max 4K)")

    has_audio = any(s.get("codec_type") == "audio" for s in streams)
    size_bytes = 0
    try:
        size_bytes = int(fmt.get("size") or os.path.getsize(path))
    except (TypeError, ValueError, OSError):
        pass

    return {
        "name": Path(path).name,
        "width": width,
        "height": height,
        "fps": round(fps, 3),
        "duration": round(duration, 3),
        "frameCount": frame_count,
        "sizeBytes": size_bytes,
        "codec": video.get("codec_name"),
        "pixFmt": video.get("pix_fmt"),
        "hasAudio": has_audio,
        "rotation": rotation,
    }


def decode_filter(settings: JobSettings) -> str:
    """Build the CPU restoration filtergraph applied before AI processing."""
    parts: list[str] = []
    if settings.decompress.enabled:
        if settings.decompress.strength == "strong":
            parts.append("deblock=filter=strong:block=8")
        else:
            parts.append("deblock=filter=weak:block=8")
    if settings.denoise.enabled:
        strength = {
            "light": "2:1.5:3:2.5",
            "medium": "4:3:6:4.5",
            "strong": "7:5:9:7",
        }[settings.denoise.strength]
        parts.append(f"hqdn3d={strength}")
    return ",".join(parts)


def build_decode_command(input_path: str, settings: JobSettings) -> list[str]:
    filters = decode_filter(settings)
    args = [
        config.FFMPEG_PATH,
        "-hide_banner", "-nostdin", "-loglevel", "error",
        "-i", input_path,
        "-map", "0:v:0",
        "-an", "-sn", "-dn",
        "-threads", str(config.FFMPEG_THREADS),
        "-fps_mode", "passthrough",
    ]
    if filters:
        args += ["-vf", filters]
    args += ["-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"]
    return args


def build_encode_command(
    width: int,
    height: int,
    fps: float,
    settings: JobSettings,
    output_path: str,
) -> list[str]:
    codec = "libx264" if settings.encode.codec == "h264" else "libx265"
    args = [
        config.FFMPEG_PATH,
        "-hide_banner", "-nostdin", "-loglevel", "error",
        "-f", "rawvideo",
        "-pix_fmt", "rgb24",
        "-s", f"{width}x{height}",
        "-framerate", f"{fps:.6f}",
        "-i", "pipe:0",
        "-an",
        "-c:v", codec,
        "-preset", settings.encode.preset,
        "-crf", str(settings.encode.crf),
        "-pix_fmt", "yuv420p",
        "-threads", str(config.FFMPEG_THREADS),
    ]
    if width % 2 or height % 2:
        args += ["-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2"]
    if settings.encode.codec == "h265" and settings.encode.container == "mp4":
        args += ["-tag:v", "hvc1"]
    if settings.encode.container == "mp4":
        args += ["-movflags", "+faststart"]
    args += ["-y", output_path]
    return args


def mux_audio(
    video_path: str,
    source_path: str,
    output_path: str,
    settings: JobSettings,
    *,
    has_audio: bool,
) -> None:
    """Mux the encoded video with the source audio; retry with AAC if stream copy fails."""
    args = [
        config.FFMPEG_PATH,
        "-hide_banner", "-nostdin", "-loglevel", "error",
        "-i", video_path,
        "-i", source_path,
        "-map", "0:v:0",
    ]
    if has_audio and settings.audio.mode == "copy":
        args += ["-map", "1:a:0?", "-c:a", "copy"]
    elif has_audio:
        args += ["-c:a", "aac", "-b:a", "192k"]
    else:
        args += ["-an"]
    args += ["-c:v", "copy"]
    if has_audio:
        try:
            args += ["-t", f"{probe_video(video_path)['duration']:.3f}"]
        except EngineError:
            args += ["-shortest"]
    args += ["-y", output_path]

    result = _run(args, timeout=1800)
    if result.returncode != 0 and has_audio and settings.audio.mode == "copy":
        log.warning("audio stream copy failed, re-encoding audio as AAC: %s", (result.stderr or "").strip()[-300:])
        retry = [
            config.FFMPEG_PATH,
            "-hide_banner", "-nostdin", "-loglevel", "error",
            "-i", video_path, "-i", source_path,
            "-map", "0:v:0", "-map", "1:a:0?",
            "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
        ]
        try:
            retry += ["-t", f"{probe_video(video_path)['duration']:.3f}"]
        except EngineError:
            retry += ["-shortest"]
        retry += ["-y", output_path]
        result = _run(retry, timeout=1800)
    if result.returncode != 0:
        detail = (result.stderr or "").strip().splitlines()
        raise EngineError("could not mux audio: " + (detail[-1] if detail else "ffmpeg failed"))


def make_thumbnail(input_path: str, thumb_path: str) -> bool:
    args = [
        config.FFMPEG_PATH,
        "-hide_banner", "-nostdin", "-loglevel", "error",
        "-ss", "0.5",
        "-i", input_path,
        "-frames:v", "1",
        "-vf", "scale=112:63:force_original_aspect_ratio=increase,crop=112:63",
        "-q:v", "5", "-y", thumb_path,
    ]
    try:
        result = _run(args, timeout=60)
        return result.returncode == 0 and Path(thumb_path).exists()
    except EngineError:
        return False


class Process:
    """A subprocess with a drained stderr pipe and a small diagnostic tail."""

    def __init__(self, args: Sequence[str], *, want_stdin: bool, want_stdout: bool) -> None:
        log.debug("spawn: %s", shlex.join(args))
        try:
            self.proc = subprocess.Popen(
                list(args),
                stdin=subprocess.PIPE if want_stdin else subprocess.DEVNULL,
                stdout=subprocess.PIPE if want_stdout else subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                bufsize=0,
                start_new_session=False,
            )
        except FileNotFoundError as exc:
            raise EngineError("ffmpeg is not installed in this container") from exc
        self._tail: deque[str] = deque(maxlen=160)
        self._stderr_thread = threading.Thread(target=self._drain_stderr, daemon=True)
        self._stderr_thread.start()

    def _drain_stderr(self) -> None:
        assert self.proc.stderr is not None
        for raw in iter(self.proc.stderr.readline, b""):
            line = raw.decode("utf-8", "replace").rstrip()
            if line:
                self._tail.append(line)

    def read_exact(self, size: int) -> bytes | None:
        assert self.proc.stdout is not None
        chunks: list[bytes] = []
        remaining = size
        while remaining > 0:
            chunk = self.proc.stdout.read(remaining)
            if not chunk:
                return None
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)

    def write(self, data: bytes) -> None:
        assert self.proc.stdin is not None
        try:
            self.proc.stdin.write(data)
        except (BrokenPipeError, ConnectionResetError) as exc:
            raise EngineError(self.describe_failure("encoder stopped accepting frames")) from exc

    def close_stdin(self) -> None:
        if self.proc.stdin is not None:
            try:
                self.proc.stdin.close()
            except OSError:
                pass

    def terminate(self) -> None:
        if self.proc.poll() is None:
            try:
                self.proc.terminate()
                self.proc.wait(timeout=5)
            except (subprocess.TimeoutExpired, OSError):
                try:
                    self.proc.kill()
                except OSError:
                    pass

    def wait(self, timeout: float = 1800) -> int:
        try:
            return self.proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired as exc:
            self.terminate()
            raise EngineError(f"ffmpeg exceeded the {int(timeout)}s time limit") from exc

    @property
    def returncode(self) -> int | None:
        return self.proc.poll()

    def tail(self, lines: int = 6) -> str:
        return " | ".join(list(self._tail)[-lines:])

    def describe_failure(self, prefix: str) -> str:
        tail = self.tail()
        return f"{prefix}: {tail}" if tail else prefix


def format_seconds(seconds: float) -> str:
    seconds = max(0, int(seconds))
    hours, rem = divmod(seconds, 3600)
    minutes, secs = divmod(rem, 60)
    if hours:
        return f"{hours}h {minutes:02d}m"
    if minutes:
        return f"{minutes}m {secs:02d}s"
    return f"{secs}s"


def now() -> float:
    return time.monotonic()
