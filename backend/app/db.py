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

CREATE TABLE IF NOT EXISTS library_items (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL,
    created_at        REAL NOT NULL,
    updated_at        REAL NOT NULL,
    active_version_id TEXT
);
CREATE TABLE IF NOT EXISTS library_versions (
    id                TEXT PRIMARY KEY,
    item_id           TEXT NOT NULL,
    parent_version_id TEXT,
    job_id            TEXT,
    path              TEXT NOT NULL,
    thumb_path        TEXT,
    label             TEXT NOT NULL,
    metadata_json     TEXT NOT NULL,
    settings_json     TEXT,
    created_at        REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_library_versions_item ON library_versions(item_id, created_at);
CREATE TABLE IF NOT EXISTS station_settings (
    key       TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
);
"""

ACTIVE_STATUSES = ("processing", "cancel_requested")
FINISHED_STATUSES = ("completed", "failed", "cancelled")

DEFAULT_STATION_SETTINGS: dict[str, Any] = {
    "processingMode": "auto",
    "defaults": {
        "encode": {"codec": "h264", "crf": 18, "preset": "veryfast", "container": "mp4"},
        "audio": {"mode": "copy"},
    },
}


def _iso(value: float | None) -> str | None:
    if not value:
        return None
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(value))


def _library_version(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "itemId": row["item_id"],
        "parentVersionId": row["parent_version_id"],
        "jobId": row["job_id"],
        "label": row["label"],
        "metadata": json.loads(row["metadata_json"]),
        "settings": json.loads(row["settings_json"]) if row["settings_json"] else {},
        "createdAt": _iso(row["created_at"]),
        "path": row["path"],
        "thumbPath": row["thumb_path"],
    }


class Database:
    def __init__(self, path: Path | None = None) -> None:
        self.path = path or (config.DATA_DIR / "rveweb.sqlite3")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.init()

    def init(self) -> None:
        with self.connect() as conn:
            conn.executescript(SCHEMA)
            columns = {row["name"] for row in conn.execute("PRAGMA table_info(jobs)")}
            if "library_item_id" not in columns:
                conn.execute("ALTER TABLE jobs ADD COLUMN library_item_id TEXT")
            if "library_parent_version_id" not in columns:
                conn.execute("ALTER TABLE jobs ADD COLUMN library_parent_version_id TEXT")
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
        max_queue: int | None = None,
        library_item_id: str | None = None,
        library_parent_version_id: str | None = None,
    ) -> dict[str, Any] | None:
        job_id = job_id or ("j_" + secrets.token_hex(6))
        now = time.time()
        with self.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                if max_queue is not None:
                    waiting = conn.execute(
                        "SELECT COUNT(*) FROM jobs WHERE status = 'queued'"
                    ).fetchone()[0]
                    if waiting >= max_queue:
                        conn.execute("ROLLBACK")
                        return None
                conn.execute(
                    """INSERT INTO jobs
                       (id, status, stage, progress, source_json, settings_json, input_path,
                        thumb_path, created_at, updated_at, library_item_id,
                        library_parent_version_id)
                       VALUES (?, 'queued', 'queued', 0, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        job_id,
                        json.dumps(source, separators=(",", ":")),
                        json.dumps(settings, separators=(",", ":")),
                        input_path,
                        thumb_path,
                        now,
                        now,
                        library_item_id,
                        library_parent_version_id,
                    ),
                )
                conn.execute("COMMIT")
            except Exception:
                conn.execute("ROLLBACK")
                raise
        return self.get_job(job_id)

    def get_job(self, job_id: str) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        return self._row_to_job(row) if row else None

    def public_job(self, job: dict[str, Any]) -> dict[str, Any]:
        public = dict(job)
        for key in (
            "createdAtSort", "input_path", "output_path", "thumb_path",
            "pid", "cancel_requested", "library_item_id",
            "library_parent_version_id",
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

    # --------------------------------------------------------------- library

    def create_library_item(
        self,
        *,
        name: str,
        version_id: str,
        path: str,
        thumb_path: str | None,
        label: str,
        metadata: dict[str, Any],
        settings: dict[str, Any] | None = None,
        item_id: str | None = None,
    ) -> dict[str, Any]:
        item_id = item_id or ("lib_" + secrets.token_hex(6))
        now = time.time()
        with self.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                conn.execute(
                    "INSERT INTO library_items (id, name, created_at, updated_at, active_version_id)"
                    " VALUES (?, ?, ?, ?, ?)",
                    (item_id, name, now, now, version_id),
                )
                conn.execute(
                    """INSERT INTO library_versions
                       (id, item_id, parent_version_id, job_id, path, thumb_path, label,
                        metadata_json, settings_json, created_at)
                       VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)""",
                    (
                        version_id, item_id, path, thumb_path, label,
                        json.dumps(metadata, separators=(",", ":")),
                        json.dumps(settings or {}, separators=(",", ":")), now,
                    ),
                )
                conn.execute("COMMIT")
            except Exception:
                conn.execute("ROLLBACK")
                raise
        return self.get_library_item(item_id) or {}

    def list_library_items(self) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                """SELECT i.id, i.name, i.created_at, i.updated_at, i.active_version_id,
                          v.label AS active_label, v.metadata_json AS active_metadata,
                          v.thumb_path AS active_thumb, v.created_at AS active_created,
                          (SELECT COUNT(*) FROM library_versions x WHERE x.item_id = i.id) AS version_count
                   FROM library_items i
                   LEFT JOIN library_versions v ON v.id = i.active_version_id
                   ORDER BY i.updated_at DESC"""
            ).fetchall()
        items = []
        for row in rows:
            metadata = json.loads(row["active_metadata"]) if row["active_metadata"] else {}
            items.append(
                {
                    "id": row["id"],
                    "name": row["name"],
                    "createdAt": _iso(row["created_at"]),
                    "updatedAt": _iso(row["updated_at"]),
                    "activeVersionId": row["active_version_id"],
                    "versionCount": row["version_count"],
                    "activeVersion": (
                        {
                            "id": row["active_version_id"],
                            "label": row["active_label"],
                            "metadata": metadata,
                            "createdAt": _iso(row["active_created"]),
                        }
                        if row["active_version_id"]
                        else None
                    ),
                }
            )
        return items

    def get_library_item(self, item_id: str) -> dict[str, Any] | None:
        with self.connect() as conn:
            item = conn.execute(
                "SELECT * FROM library_items WHERE id = ?", (item_id,)
            ).fetchone()
            if item is None:
                return None
            versions = conn.execute(
                "SELECT * FROM library_versions WHERE item_id = ? ORDER BY created_at ASC",
                (item_id,),
            ).fetchall()
        version_list = [_library_version(row) for row in versions]
        active = next(
            (version for version in version_list if version["id"] == item["active_version_id"]),
            version_list[-1] if version_list else None,
        )
        return {
            "id": item["id"],
            "name": item["name"],
            "createdAt": _iso(item["created_at"]),
            "updatedAt": _iso(item["updated_at"]),
            "activeVersionId": item["active_version_id"],
            "versionCount": len(version_list),
            "versions": version_list,
            "activeVersion": active,
        }

    def get_library_version(self, version_id: str) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute(
                """SELECT v.*, i.name AS item_name
                   FROM library_versions v JOIN library_items i ON i.id = v.item_id
                   WHERE v.id = ?""",
                (version_id,),
            ).fetchone()
        if row is None:
            return None
        version = _library_version(row)
        version["itemName"] = row["item_name"]
        return version

    def add_library_version(
        self,
        *,
        item_id: str,
        parent_version_id: str | None,
        job_id: str,
        path: str,
        thumb_path: str | None,
        label: str,
        metadata: dict[str, Any],
        settings: dict[str, Any],
        version_id: str | None = None,
    ) -> dict[str, Any]:
        version_id = version_id or ("v_" + secrets.token_hex(6))
        now = time.time()
        with self.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                conn.execute(
                    """INSERT INTO library_versions
                       (id, item_id, parent_version_id, job_id, path, thumb_path, label,
                        metadata_json, settings_json, created_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        version_id, item_id, parent_version_id, job_id, path, thumb_path,
                        label, json.dumps(metadata, separators=(",", ":")),
                        json.dumps(settings, separators=(",", ":")), now,
                    ),
                )
                conn.execute(
                    "UPDATE library_items SET active_version_id = ?, updated_at = ? WHERE id = ?",
                    (version_id, now, item_id),
                )
                conn.execute("COMMIT")
            except Exception:
                conn.execute("ROLLBACK")
                raise
        return self.get_library_version(version_id) or {}

    def set_library_active(self, item_id: str, version_id: str) -> bool:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT 1 FROM library_versions WHERE id = ? AND item_id = ?",
                (version_id, item_id),
            ).fetchone()
            if row is None:
                return False
            conn.execute(
                "UPDATE library_items SET active_version_id = ?, updated_at = ? WHERE id = ?",
                (version_id, time.time(), item_id),
            )
        return True

    def delete_library_item(self, item_id: str) -> bool:
        with self.connect() as conn:
            row = conn.execute("SELECT id FROM library_items WHERE id = ?", (item_id,)).fetchone()
            if row is None:
                return False
            conn.execute("DELETE FROM library_versions WHERE item_id = ?", (item_id,))
            conn.execute("DELETE FROM library_items WHERE id = ?", (item_id,))
        return True

    def library_item_busy(self, item_id: str) -> bool:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT COUNT(*) FROM jobs WHERE library_item_id = ? AND status IN ('processing','cancel_requested','queued')",
                (item_id,),
            ).fetchone()
        return bool(row and row[0])

    def public_library_item(self, item: dict[str, Any]) -> dict[str, Any]:
        public = {
            "id": item["id"],
            "name": item["name"],
            "createdAt": item["createdAt"],
            "updatedAt": item["updatedAt"],
            "activeVersionId": item["activeVersionId"],
            "versionCount": item["versionCount"],
            "versions": [
                {key: value for key, value in version.items() if key not in ("path", "thumbPath")}
                for version in item.get("versions", [])
            ],
        }
        public["activeVersion"] = next(
            (v for v in public["versions"] if v["id"] == item["activeVersionId"]),
            public["versions"][-1] if public["versions"] else None,
        )
        return public

    # --------------------------------------------------------------- settings

    def get_station_settings(self) -> dict[str, Any]:
        settings = json.loads(json.dumps(DEFAULT_STATION_SETTINGS))
        with self.connect() as conn:
            rows = conn.execute("SELECT key, value_json FROM station_settings").fetchall()
        for row in rows:
            try:
                settings[row["key"]] = json.loads(row["value_json"])
            except json.JSONDecodeError:
                continue
        return settings

    def save_station_settings(self, settings: dict[str, Any]) -> None:
        with self.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                for key, value in settings.items():
                    conn.execute(
                        "INSERT INTO station_settings (key, value_json) VALUES (?, ?)"
                        " ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
                        (key, json.dumps(value, separators=(",", ":"))),
                    )
                conn.execute("COMMIT")
            except Exception:
                conn.execute("ROLLBACK")
                raise

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
            "library_item_id": row["library_item_id"],
            "library_parent_version_id": row["library_parent_version_id"],
            "library": (
                {
                    "itemId": row["library_item_id"],
                    "parentVersionId": row["library_parent_version_id"],
                }
                if row["library_item_id"]
                else None
            ),
        }
        return job
