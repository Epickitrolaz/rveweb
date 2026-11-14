"""SQLite persistence for jobs.

The API process and short-lived worker processes share this database. WAL mode plus a
busy timeout keeps concurrent reads/writes predictable without a separate queue server.
"""

from __future__ import annotations

import json
import secrets
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    id               TEXT PRIMARY KEY,
    status           TEXT NOT NULL,
    stage            TEXT NOT NULL DEFAULT 'queued',
    progress         REAL NOT NULL DEFAULT 0,
    eta_seconds      INTEGER,
    source_json      TEXT NOT NULL,
    settings_json    TEXT NOT NULL,
    output_json      TEXT,
    error            TEXT,
    input_path       TEXT NOT NULL,
    output_path      TEXT,
    thumb_path       TEXT,
    created_at       REAL NOT NULL,
    started_at       REAL,
    completed_at     REAL,
    updated_at       REAL NOT NULL,
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    pid              INTEGER
);
CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at);
"""

ACTIVE_STATUSES = ("processing", "cancel_requested")
FINISHED_STATUSES = ("completed", "failed", "cancelled")


class Database:
    def __init__(self, path: Path | None = None) -> None:
        self.path = path or (config.DATA_DIR / "rveweb.sqlite3")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.init()

    def init(self) -> None:
        with self.connect() as conn:
            conn.executescript(SCHEMA)
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=NORMAL")
            conn.execute("PRAGMA wal_autocheckpoint=256")

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        conn.row_factory = sqlite3.Row
        try:
            conn.execute("PRAGMA busy_timeout=10000")
            conn.execute("PRAGMA foreign_keys=ON")
            yield conn
        finally:
            conn.close()

    # ------------------------------------------------------------------ jobs

    def create_job(
        self,
        *,
        source: dict[str, Any],
        settings: dict[str, Any],
        input_path: str,
        thumb_path: str | None,
        job_id: str | None = None,
    ) -> dict[str, Any]:
        job_id = job_id or ("j_" + secrets.token_hex(6))
        now = time.time()
        with self.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute(
                """INSERT INTO jobs
                   (id, status, stage, progress, source_json, settings_json, input_path,
                    thumb_path, created_at, updated_at)
                   VALUES (?, 'queued', 'queued', 0, ?, ?, ?, ?, ?, ?)""",
                (
                    job_id,
                    json.dumps(source, separators=(",", ":")),
                    json.dumps(settings, separators=(",", ":")),
                    input_path,
                    thumb_path,
                    now,
                    now,
                ),
            )
            conn.execute("COMMIT")
        job = self.get_job(job_id)
        assert job is not None
        return job

    def get_job(self, job_id: str) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        return self._row_to_job(row) if row else None

    def public_job(self, job: dict[str, Any]) -> dict[str, Any]:
        public = dict(job)
        for key in (
            "createdAtSort", "input_path", "output_path", "thumb_path",
            "pid", "cancel_requested",
        ):
            public.pop(key, None)
        return public

    def list_jobs(self, limit: int = 20) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?", (limit,)
            ).fetchall()
        jobs = [self._row_to_job(row) for row in rows]
        queued = sorted(
            (j for j in jobs if j["status"] == "queued"), key=lambda j: j["createdAtSort"]
        )
        positions = {job["id"]: index + 1 for index, job in enumerate(queued)}
        for job in jobs:
            job["queuePosition"] = positions.get(job["id"])
        return jobs

    def queue_counts(self) -> dict[str, int]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT status, COUNT(*) AS n FROM jobs GROUP BY status"
            ).fetchall()
        counts = {row["status"]: row["n"] for row in rows}
        active = counts.get("processing", 0) + counts.get("cancel_requested", 0)
        return {"active": active, "queued": counts.get("queued", 0)}

    def claim_next(self, max_active: int) -> dict[str, Any] | None:
        """Atomically mark the oldest queued job as processing, if a slot is free."""
        now = time.time()
        with self.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                active = conn.execute(
                    "SELECT COUNT(*) FROM jobs WHERE status IN ('processing', 'cancel_requested')"
                ).fetchone()[0]
                if active >= max_active:
                    conn.execute("COMMIT")
                    return None
                row = conn.execute(
                    "SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1"
                ).fetchone()
                if row is None:
                    conn.execute("COMMIT")
                    return None
                conn.execute(
                    """UPDATE jobs SET status='processing', stage='decode', started_at=?,
                       updated_at=?, cancel_requested=0, error=NULL
                       WHERE id=? AND status='queued'""",
                    (now, now, row["id"]),
                )
                conn.execute("COMMIT")
            except Exception:
                conn.execute("ROLLBACK")
                raise
        return self.get_job(row["id"])

    def update_job(self, job_id: str, **fields: Any) -> None:
        if not fields:
            return
        allowed = {
            "status", "stage", "progress", "eta_seconds", "output_json", "error",
            "output_path", "completed_at", "pid", "cancel_requested",
        }
        updates = {k: v for k, v in fields.items() if k in allowed}
        if not updates:
            return
        updates["updated_at"] = time.time()
        assignments = ", ".join(f"{key} = ?" for key in updates)
        with self.connect() as conn:
            conn.execute(f"UPDATE jobs SET {assignments} WHERE id = ?", (*updates.values(), job_id))

    def request_cancel(self, job_id: str) -> None:
        with self.connect() as conn:
            conn.execute(
                "UPDATE jobs SET cancel_requested=1, status='cancel_requested', updated_at=? WHERE id=?",
                (time.time(), job_id),
            )

    def cancel_requested(self, job_id: str) -> bool:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT cancel_requested, status FROM jobs WHERE id=?", (job_id,)
            ).fetchone()
        return bool(row and (row["cancel_requested"] or row["status"] in ("cancel_requested", "cancelled")))

    def delete_job(self, job_id: str) -> None:
        with self.connect() as conn:
            conn.execute("DELETE FROM jobs WHERE id = ?", (job_id,))

    def recover_interrupted(self) -> int:
        """Mark jobs left in-flight by a crash/restart as failed."""
        now = time.time()
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT id FROM jobs WHERE status IN ('processing','cancel_requested')"
            ).fetchall()
            for row in rows:
                conn.execute(
                    """UPDATE jobs SET status='failed',
                       error='Processing was interrupted by a server restart. Submit the clip again.',
                       completed_at=?, updated_at=? WHERE id=?""",
                    (now, now, row["id"]),
                )
        return len(rows)

    def cleanup_expired(self, retention_hours: int) -> list[str]:
        cutoff = time.time() - retention_hours * 3600
        with self.connect() as conn:
            rows = conn.execute(
                """SELECT id FROM jobs WHERE status IN ('completed','failed','cancelled')
                   AND COALESCE(completed_at, updated_at) < ?""",
                (cutoff,),
            ).fetchall()
        return [row["id"] for row in rows]

    def failed_startup_jobs(self) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM jobs WHERE status IN ('processing','cancel_requested')"
            ).fetchall()
        return [self._row_to_job(row) for row in rows]

    # ------------------------------------------------------------- serializer

    @staticmethod
    def _row_to_job(row: sqlite3.Row) -> dict[str, Any]:
        def iso(value: float | None) -> str | None:
            if not value:
                return None
            return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(value))

        job = {
            "id": row["id"],
            "status": row["status"],
            "stage": row["stage"],
            "progress": round(min(1.0, max(0.0, row["progress"])), 4),
            "etaSeconds": row["eta_seconds"],
            "source": json.loads(row["source_json"]),
            "settings": json.loads(row["settings_json"]),
            "output": json.loads(row["output_json"]) if row["output_json"] else None,
            "error": row["error"],
            "createdAt": iso(row["created_at"]),
            "startedAt": iso(row["started_at"]),
            "completedAt": iso(row["completed_at"]),
            "queuePosition": None,
            "createdAtSort": row["created_at"],
            "input_path": row["input_path"],
            "output_path": row["output_path"],
            "thumb_path": row["thumb_path"],
            "pid": row["pid"],
            "cancel_requested": bool(row["cancel_requested"]),
        }
        return job
