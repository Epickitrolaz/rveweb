"""One job, one process. The API never runs inference in its own address space."""

from __future__ import annotations

import json
import logging
import os
import signal
import sys
import time
import traceback
from pathlib import Path

from . import config
from .db import Database
from .engine.ffmpeg import EngineError
from .engine.pipeline import Cancelled, Pipeline
from .schemas import JobSettings

log = logging.getLogger("rveweb.worker")


def _configure_logging() -> None:
    logging.basicConfig(
        level=getattr(logging, config.LOG_LEVEL, logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stdout,
    )


def _friendly_error(exc: BaseException, job_dir: Path) -> str:
    message = str(exc) or exc.__class__.__name__
    message = message.replace(str(job_dir), "job")
    message = " ".join(message.split())
    return message[:900]


def _handle_term(signum, frame):  # noqa: ANN001
    raise KeyboardInterrupt(f"signal {signum}")


def main(argv: list[str] | None = None) -> int:
    _configure_logging()
    args = argv or sys.argv[1:]
    if len(args) != 1:
        print("usage: python -m app.worker <job-id>", file=sys.stderr)
        return 2
    job_id = args[0]
    signal.signal(signal.SIGTERM, _handle_term)
    signal.signal(signal.SIGINT, _handle_term)

    db = Database()
    job = db.get_job(job_id)
    if job is None:
        log.error("job %s no longer exists", job_id)
        return 2
    if job["status"] in ("cancelled", "completed", "failed"):
        log.info("job %s is already %s", job_id, job["status"])
        return 0
    if job["status"] == "cancel_requested":
        db.update_job(job_id, status="cancelled", completed_at=time.time(), eta_seconds=None)
        return 0

    input_path = job["input_path"]
    job_dir = Path(input_path).parent
    try:
        settings = JobSettings.model_validate(job["settings"])
    except Exception as exc:
        db.update_job(
            job_id,
            status="failed",
            error=f"The stored settings are invalid: {exc}"[:900],
            completed_at=time.time(),
            eta_seconds=None,
        )
        return 2

    output_path = str(job_dir / f"output.{settings.encode.container}")

    def progress(fraction: float, stage: str, eta: int | None) -> None:
        try:
            db.update_job(
                job_id,
                progress=round(fraction, 4),
                stage=stage,
                eta_seconds=eta,
            )
        except Exception:
            log.debug("could not persist progress", exc_info=True)

    def cancelled() -> bool:
        return db.cancel_requested(job_id)

    log.info("worker starting job %s", job_id)
    pipeline = Pipeline(
        input_path=input_path,
        output_path=output_path,
        settings=settings,
        source=job["source"],
        progress=progress,
        cancelled=cancelled,
    )

    try:
        info = pipeline.run()
        if db.cancel_requested(job_id):
            raise Cancelled()
        if not os.path.exists(output_path) or os.path.getsize(output_path) == 0:
            raise EngineError("the encoder produced an empty file")

        container = settings.encode.container
        stem = Path(job["source"].get("name") or "video").stem
        friendly = f"{stem}-enhanced.{container}"
        info["filename"] = friendly
        db.update_job(
            job_id,
            status="completed",
            stage="done",
            progress=1.0,
            eta_seconds=None,
            output_path=output_path,
            output_json=json.dumps(info, separators=(",", ":")),
            completed_at=time.time(),
            error=None,
        )
        log.info("job %s completed successfully", job_id)
        return 0
    except Cancelled:
        log.info("job %s cancelled", job_id)
        db.update_job(
            job_id,
            status="cancelled",
            eta_seconds=None,
            completed_at=time.time(),
            error=None,
        )
        try:
            os.unlink(output_path)
        except OSError:
            pass
        return 3
    except KeyboardInterrupt:
        log.warning("job %s interrupted by a signal", job_id)
        db.update_job(
            job_id,
            status="cancelled",
            eta_seconds=None,
            completed_at=time.time(),
            error=None,
        )
        try:
            os.unlink(output_path)
        except OSError:
            pass
        return 3
    except EngineError as exc:
        message = _friendly_error(exc, job_dir)
        log.error("job %s failed: %s", job_id, message)
        _remove_file(output_path)
        db.update_job(
            job_id,
            status="failed",
            error=message,
            eta_seconds=None,
            completed_at=time.time(),
        )
        return 2
    except Exception as exc:  # noqa: BLE001
        log.error("job %s failed unexpectedly:\n%s", job_id, traceback.format_exc())
        _remove_file(output_path)
        db.update_job(
            job_id,
            status="failed",
            error=_friendly_error(exc, job_dir),
            eta_seconds=None,
            completed_at=time.time(),
        )
        return 2
    finally:
        try:
            for path in job_dir.glob("video-only.*"):
                path.unlink()
        except OSError:
            pass


def _remove_file(path: str) -> None:
    try:
        os.unlink(path)
    except OSError:
        pass


if __name__ == "__main__":
    sys.exit(main())
