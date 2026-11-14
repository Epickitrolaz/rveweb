"""Supervisor that turns queued jobs into crash-isolated worker processes."""

from __future__ import annotations

import logging
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

from . import config
from .db import ACTIVE_STATUSES, Database

log = logging.getLogger(__name__)


@dataclass
class RunningJob:
    job_id: str
    process: subprocess.Popen
    started_at: float
    timeout: float
    log_path: Path
    cancel_sent_at: float | None = None
    kill_reason: str | None = None
    force_killed: bool = False


class JobManager:
    def __init__(self, db: Database) -> None:
        self.db = db
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, name="job-manager", daemon=True)
        self._running: dict[str, RunningJob] = {}
        self._next_cleanup = 0.0

    # ------------------------------------------------------------- lifecycle

    def start(self) -> None:
        self._cleanup_partials()
        self._cleanup_orphan_uploads()
        interrupted = self.db.recover_interrupted()
        if interrupted:
            log.warning("marked %d interrupted job(s) as failed after restart", interrupted)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._thread.join(timeout=8)
        self._shutdown_running()

    def _shutdown_running(self) -> None:
        for running in list(self._running.values()):
            log.warning("stopping worker for job %s", running.job_id)
            self._signal_group(running, signal.SIGTERM)
        deadline = time.monotonic() + 5
        for running in list(self._running.values()):
            remaining = max(0.1, deadline - time.monotonic())
            try:
                running.process.wait(timeout=remaining)
            except subprocess.TimeoutExpired:
                self._signal_group(running, signal.SIGKILL)
        for running in list(self._running.values()):
            job = self.db.get_job(running.job_id)
            if job is not None and job["status"] not in ACTIVE_STATUSES:
                continue
            self.db.update_job(
                running.job_id,
                status="failed",
                error="The server stopped while this job was processing. Submit the clip again.",
                completed_at=time.time(),
                eta_seconds=None,
            )
        self._running.clear()

    # ------------------------------------------------------------------ loop

    def _loop(self) -> None:
        while not self._stop.wait(0.5):
            try:
                self._tick()
            except Exception:
                log.exception("job manager tick failed")

    def _tick(self) -> None:
        self._reap()
        self._dispatch()
        if time.monotonic() >= self._next_cleanup:
            self._next_cleanup = time.monotonic() + 300
            self._cleanup_expired()

    def _dispatch(self) -> None:
        counts = self.db.queue_counts()
        slots = config.MAX_ACTIVE_JOBS - counts["active"]
        while slots > 0 and not self._stop.is_set():
            job = self.db.claim_next(config.MAX_ACTIVE_JOBS)
            if job is None:
                return
            try:
                self._spawn(job)
            except Exception as exc:  # noqa: BLE001
                log.exception("failed to spawn job %s", job["id"])
                self._fail(job["id"], f"could not start the processing worker: {exc}")
            slots -= 1

    def _spawn(self, job: dict) -> None:
        job_id = job["id"]
        job_dir = Path(job["input_path"]).parent
        log_path = job_dir / "worker.log"
        duration = float(job["source"].get("duration") or 0)
        timeout = min(
            config.JOB_TIMEOUT_MAX,
            max(config.JOB_TIMEOUT_MIN, int(duration * config.JOB_TIMEOUT_PER_SECOND + 120)),
        )
        env = os.environ.copy()
        env["PYTHONUNBUFFERED"] = "1"
        env.setdefault("LOG_LEVEL", config.LOG_LEVEL)
        try:
            log_file = open(log_path, "ab", buffering=0)
        except OSError as exc:
            self._fail(job_id, f"could not create the job log: {exc}")
            return
        try:
            process = subprocess.Popen(
                [sys.executable, "-m", "app.worker", job_id],
                cwd=str(config.APP_DIR),
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=log_file,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
        except Exception as exc:
            log_file.close()
            self._fail(job_id, f"could not start the processing worker: {exc}")
            return
        finally:
            try:
                log_file.close()
            except OSError:
                pass

        self.db.update_job(job_id, pid=process.pid)
        self._running[job_id] = RunningJob(
            job_id=job_id,
            process=process,
            started_at=time.monotonic(),
            timeout=timeout,
            log_path=log_path,
        )
        log.info("started job %s (pid %d, timeout %ds)", job_id, process.pid, timeout)

    # ------------------------------------------------------------------ reaps

    def _reap(self) -> None:
        now = time.monotonic()
        for job_id, running in list(self._running.items()):
            job = self.db.get_job(job_id)
            if job is None:
                self._signal_group(running, signal.SIGKILL)
                self._running.pop(job_id, None)
                continue

            if job["status"] == "cancel_requested" and running.cancel_sent_at is None:
                log.info("cancelling job %s", job_id)
                running.kill_reason = "cancelled"
                running.cancel_sent_at = now
                self._signal_group(running, signal.SIGTERM)

            if running.cancel_sent_at is not None and not running.force_killed:
                if now - running.cancel_sent_at > 5:
                    log.warning("force-killing job %s", job_id)
                    self._signal_group(running, signal.SIGKILL)
                    running.force_killed = True

            if running.kill_reason is None and now - running.started_at > running.timeout:
                log.warning("job %s exceeded its %ds timeout", job_id, int(running.timeout))
                running.kill_reason = "timeout"
                self._signal_group(running, signal.SIGKILL)

            code = running.process.poll()
            if code is None:
                continue

            # The worker leads its own session. If it died without reaping ffmpeg,
            # kill any survivors in that process group before forgetting the job.
            self._kill_group_pid(running.process.pid)

            current = self.db.get_job(job_id)
            if current is not None and current["status"] in ACTIVE_STATUSES:
                if running.kill_reason == "cancelled" or current["status"] == "cancel_requested":
                    self.db.update_job(
                        job_id,
                        status="cancelled",
                        eta_seconds=None,
                        completed_at=time.time(),
                        error=None,
                    )
                elif running.kill_reason == "timeout":
                    self.db.update_job(
                        job_id,
                        status="failed",
                        error="Processing exceeded the job time limit. Try a shorter clip or lighter settings.",
                        eta_seconds=None,
                        completed_at=time.time(),
                    )
                else:
                    tail = self._read_tail(running.log_path)
                    if tail:
                        log.error("job %s worker log tail: %s", job_id, tail)
                    self.db.update_job(
                        job_id,
                        status="failed",
                        error=(
                            "The processing worker stopped unexpectedly. "
                            "The station logged the failure for the operator."
                        ),
                        eta_seconds=None,
                        completed_at=time.time(),
                    )
            self._running.pop(job_id, None)
            log.info("job %s worker exited with code %s", job_id, code)
            if current is None or current["status"] != "completed":
                self._remove_temp_files(job_id)

    @staticmethod
    def _read_tail(path: Path, limit: int = 1200) -> str:
        try:
            data = path.read_bytes()[-limit:]
            return " ".join(data.decode("utf-8", "replace").split())
        except OSError:
            return ""

    @staticmethod
    def _kill_group_pid(pid: int) -> None:
        try:
            os.killpg(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            pass

    @staticmethod
    def _signal_group(running: RunningJob, sig: int) -> None:
        try:
            os.killpg(os.getpgid(running.process.pid), sig)
        except (ProcessLookupError, PermissionError, OSError):
            try:
                if sig == signal.SIGKILL:
                    running.process.kill()
                else:
                    running.process.terminate()
            except OSError:
                pass

    def _fail(self, job_id: str, message: str) -> None:
        log.error("job %s failed before start: %s", job_id, message)
        self.db.update_job(
            job_id, status="failed", error=message, completed_at=time.time(), eta_seconds=None
        )

    # --------------------------------------------------------------- cleanup

    def _remove_temp_files(self, job_id: str) -> None:
        job = self.db.get_job(job_id)
        if not job:
            return
        job_dir = Path(job["input_path"]).parent
        for pattern in ("video-only.*", "*.part"):
            for path in job_dir.glob(pattern):
                try:
                    path.unlink()
                except OSError:
                    pass

    def _cleanup_partials(self) -> None:
        for job in self.db.failed_startup_jobs():
            job_dir = Path(job["input_path"]).parent
            if job.get("output"):
                output_path = job.get("output_path")
                if output_path:
                    try:
                        Path(output_path).unlink()
                    except OSError:
                        pass
            for path in job_dir.glob("video-only.*"):
                try:
                    path.unlink()
                except OSError:
                    pass

    def _cleanup_orphan_uploads(self) -> None:
        upload_root = config.DATA_DIR / "uploads"
        if not upload_root.exists():
            return
        cutoff = time.time() - 2 * 3600
        for path in upload_root.iterdir():
            try:
                if path.is_dir() and path.stat().st_mtime < cutoff:
                    shutil.rmtree(path, ignore_errors=True)
                    log.info("removed stale upload %s", path.name)
            except OSError:
                continue

    def _cleanup_expired(self) -> None:
        for job_id in self.db.cleanup_expired(config.RETENTION_HOURS):
            job = self.db.get_job(job_id)
            if job is None:
                continue
            if job["status"] in ACTIVE_STATUSES:
                continue
            job_dir = Path(job["input_path"]).parent
            self.db.delete_job(job_id)
            try:
                shutil.rmtree(job_dir, ignore_errors=True)
                log.info("removed expired job %s", job_id)
            except OSError:
                log.warning("could not remove expired job directory %s", job_dir)
