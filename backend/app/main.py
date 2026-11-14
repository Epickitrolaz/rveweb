"""FastAPI application: HTTP API, queue supervision, library, and the console."""

from __future__ import annotations

import asyncio
import logging
import os
import secrets
import shutil
import tempfile
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

from . import config
from .catalog import INTERPOLATORS
from .db import Database
from .engine.ffmpeg import EngineError, make_thumbnail, probe_video
from .manager import JobManager
from .schemas import LibraryActivate, StationSettingsUpdate, parse_settings
from .system import gpu_info, system_info, uptime_seconds

log = logging.getLogger("rveweb.api")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logging.basicConfig(
        level=getattr(logging, config.LOG_LEVEL, logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    db = Database()
    manager = JobManager(db)
    manager.start()
    app.state.db = db
    app.state.manager = manager
    app.state.upload_sem = asyncio.Semaphore(config.MAX_INFLIGHT_UPLOADS)
    log.info("RVEWeb %s ready (data=%s, models=%s)", config.VERSION, config.DATA_DIR, config.MODEL_DIR)
    try:
        yield
    finally:
        manager.stop()
        log.info("RVEWeb stopped")


app = FastAPI(
    title="RVEWeb",
    version=config.VERSION,
    lifespan=lifespan,
    docs_url="/api/docs",
    redoc_url=None,
    openapi_url="/api/openapi.json",
)


@app.middleware("http")
async def request_guard(request: Request, call_next):
    if request.method == "POST" and request.url.path in ("/api/jobs", "/api/library"):
        raw_length = request.headers.get("content-length")
        if raw_length:
            try:
                if int(raw_length) > config.MAX_UPLOAD_BYTES + 2 * 1024 * 1024:
                    return JSONResponse(
                        {"detail": f"upload is larger than {config.MAX_UPLOAD_MB} MB"},
                        status_code=413,
                    )
            except ValueError:
                return JSONResponse({"detail": "invalid Content-Length header"}, status_code=400)
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    response.headers.setdefault("X-Frame-Options", "DENY")
    return response


@app.exception_handler(RequestValidationError)
async def validation_handler(request: Request, exc: RequestValidationError):
    parts = []
    for error in exc.errors():
        location = ".".join(str(piece) for piece in error.get("loc", ()) if piece != "body")
        parts.append(f"{location}: {error.get('msg')}" if location else str(error.get("msg")))
    return JSONResponse({"detail": "; ".join(parts)[:900]}, status_code=422)


@app.exception_handler(Exception)
async def unhandled_handler(request: Request, exc: Exception):
    log.exception("unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse({"detail": "internal server error"}, status_code=500)


def get_db(request: Request) -> Database:
    return request.app.state.db


@app.get("/health")
async def health():
    return {"status": "ok", "version": config.VERSION, "uptimeSeconds": uptime_seconds()}


@app.get("/api/system")
async def api_system(db: Database = Depends(get_db)):
    return system_info(db.queue_counts())


# --------------------------------------------------------------------- jobs


@app.get("/api/jobs")
async def api_list_jobs(
    limit: int = Query(default=20, ge=1, le=50),
    db: Database = Depends(get_db),
):
    jobs = [db.public_job(job) for job in db.list_jobs(limit)]
    return {"jobs": jobs, "queue": _queue_payload(db)}


@app.get("/api/jobs/{job_id}")
async def api_get_job(job_id: str, db: Database = Depends(get_db)):
    job = db.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    return db.public_job(job)


@app.post("/api/jobs", status_code=201)
async def api_create_job(
    request: Request,
    file: UploadFile | None = File(default=None),
    library_version_id: str | None = Form(default=None, alias="libraryVersionId"),
    settings: str = Form(...),
    db: Database = Depends(get_db),
):
    if file is None and not library_version_id:
        raise HTTPException(status_code=422, detail="provide a video file or a libraryVersionId")
    if file is not None and library_version_id:
        raise HTTPException(status_code=422, detail="provide either a file or a libraryVersionId, not both")

    try:
        parsed, mode = _prepare_settings(db, settings)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    counts = db.queue_counts()
    if counts["queued"] >= config.MAX_QUEUE:
        raise HTTPException(
            status_code=429,
            detail=f"The queue is full ({config.MAX_QUEUE} waiting). Let a job finish, then try again.",
        )
    _require_disk_space()

    if library_version_id:
        return await _create_library_job(db, library_version_id, parsed, mode)
    return await _create_upload_job(request, db, file, parsed, mode)


async def _create_library_job(db: Database, version_id: str, parsed, mode: str):
    version = db.get_library_version(version_id)
    if version is None:
        raise HTTPException(status_code=404, detail="library version not found")
    item = db.get_library_item(version["itemId"])
    if item is None:
        raise HTTPException(status_code=404, detail="library item not found")
    source_path = Path(version["path"])
    if not source_path.exists():
        raise HTTPException(status_code=410, detail="the library file is no longer available")
    _validate_output_size(version["metadata"], parsed)
    _require_disk_space()

    job_id = "j_" + secrets.token_hex(6)
    job_dir = config.JOBS_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    ext = source_path.suffix
    dest = job_dir / f"input{ext}"
    try:
        _link_or_copy(source_path, dest)
        thumb = job_dir / "thumb.jpg"
        if version.get("thumbPath") and Path(version["thumbPath"]).exists():
            shutil.copy2(version["thumbPath"], thumb)
        else:
            make_thumbnail(str(dest), str(thumb))
        source = dict(version["metadata"])
        source["name"] = item["name"]
        source["libraryVersionId"] = version_id
        job = db.create_job(
            source=source,
            settings=parsed.model_dump(),
            input_path=str(dest),
            thumb_path=str(thumb) if thumb.exists() else None,
            job_id=job_id,
            max_queue=config.MAX_QUEUE,
            library_item_id=item["id"],
            library_parent_version_id=version_id,
        )
        if job is None:
            raise HTTPException(
                status_code=429,
                detail=f"The queue is full ({config.MAX_QUEUE} waiting). Let a job finish, then try again.",
            )
    except BaseException:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise

    log.info("accepted library job %s (%s, version %s, mode %s)", job_id, item["name"], version_id, mode)
    return db.public_job(job)


async def _create_upload_job(request: Request, db: Database, file: UploadFile, parsed, mode: str):
    original_name = Path(file.filename or "video").name
    extension = Path(original_name).suffix.lower()
    if extension not in config.ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=415,
            detail="Unsupported file type. Use MP4, MKV, MOV, WebM, AVI, or another common video format.",
        )

    semaphore: asyncio.Semaphore = request.app.state.upload_sem
    if semaphore.locked():
        raise HTTPException(
            status_code=429,
            detail="Too many uploads at once. Wait for the current uploads to finish.",
        )

    async with semaphore:
        upload_root = config.DATA_DIR / "uploads"
        upload_root.mkdir(parents=True, exist_ok=True)
        staging = Path(tempfile.mkdtemp(prefix="upload-", dir=upload_root))
        staged_file = staging / f"input{extension}"
        final_dir: Path | None = None
        try:
            total = await _stream_upload(file, staged_file)
            if total == 0:
                raise HTTPException(status_code=422, detail="The uploaded file is empty.")
            try:
                meta = await run_in_threadpool(probe_video, str(staged_file))
            except EngineError as exc:
                raise HTTPException(status_code=422, detail=str(exc)) from exc
            _validate_output_size(meta, parsed)
            thumb_path = staging / "thumb.jpg"
            has_thumb = await run_in_threadpool(make_thumbnail, str(staged_file), str(thumb_path))

            job_id = "j_" + secrets.token_hex(6)
            final_dir = config.JOBS_DIR / job_id
            final_dir.parent.mkdir(parents=True, exist_ok=True)
            os.replace(staging, final_dir)
            final_input = final_dir / staged_file.name
            final_thumb = final_dir / "thumb.jpg" if has_thumb else None
            _require_disk_space()

            source = dict(meta)
            source["name"] = original_name
            source["sizeBytes"] = total
            job = db.create_job(
                source=source,
                settings=parsed.model_dump(),
                input_path=str(final_input),
                thumb_path=str(final_thumb) if final_thumb else None,
                job_id=job_id,
                max_queue=config.MAX_QUEUE,
            )
            if job is None:
                raise HTTPException(
                    status_code=429,
                    detail=f"The queue is full ({config.MAX_QUEUE} waiting). Let a job finish, then try again.",
                )
            log.info(
                "accepted job %s (%s, %.1f MB, %dx%d@%.2f, mode %s)",
                job_id, original_name, total / 1e6, meta["width"], meta["height"], meta["fps"], mode,
            )
            return db.public_job(job)
        except BaseException:
            shutil.rmtree(staging, ignore_errors=True)
            if final_dir is not None:
                shutil.rmtree(final_dir, ignore_errors=True)
            raise


@app.post("/api/jobs/{job_id}/cancel", status_code=202)
async def api_cancel_job(job_id: str, db: Database = Depends(get_db)):
    job = db.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    if job["status"] in ("completed", "failed", "cancelled"):
        raise HTTPException(status_code=409, detail="this job has already finished")
    if job["status"] == "queued":
        db.update_job(job_id, status="cancelled", eta_seconds=None, completed_at=time.time())
    else:
        db.request_cancel(job_id)
    current = db.get_job(job_id)
    return db.public_job(current) if current else {"id": job_id, "status": "cancelled"}


@app.delete("/api/jobs/{job_id}", status_code=204)
async def api_delete_job(job_id: str, db: Database = Depends(get_db)):
    job = db.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    if job["status"] in ("processing", "cancel_requested", "queued"):
        raise HTTPException(status_code=409, detail="cancel the job before removing it")
    job_dir = Path(job["input_path"]).parent
    db.delete_job(job_id)
    shutil.rmtree(job_dir, ignore_errors=True)
    return Response(status_code=204)


@app.get("/api/jobs/{job_id}/download")
async def api_download(job_id: str, db: Database = Depends(get_db)):
    job = db.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    if job["status"] != "completed" or not job.get("output_path"):
        raise HTTPException(status_code=409, detail="this job has no finished output")
    path = Path(job["output_path"])
    if not path.exists():
        raise HTTPException(status_code=404, detail="the output file is no longer available")
    output = job.get("output") or {}
    filename = output.get("filename") or f"{job_id}.mp4"
    return FileResponse(path, media_type=_media_type(filename), filename=filename)


@app.get("/api/jobs/{job_id}/thumbnail")
async def api_thumbnail(job_id: str, db: Database = Depends(get_db)):
    job = db.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    thumb = job.get("thumb_path")
    if not thumb or not Path(thumb).exists():
        raise HTTPException(status_code=404, detail="no thumbnail available")
    return FileResponse(thumb, media_type="image/jpeg")


# ------------------------------------------------------------------ library


@app.get("/api/library")
async def api_library_list(db: Database = Depends(get_db)):
    items = db.list_library_items()
    return {"items": items, "count": len(items)}


@app.get("/api/library/{item_id}")
async def api_library_item(item_id: str, db: Database = Depends(get_db)):
    item = db.get_library_item(item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="library item not found")
    return db.public_library_item(item)


@app.post("/api/library", status_code=201)
async def api_library_upload(
    request: Request,
    file: UploadFile = File(...),
    db: Database = Depends(get_db),
):
    original_name = Path(file.filename or "video").name
    extension = Path(original_name).suffix.lower()
    if extension not in config.ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=415,
            detail="Unsupported file type. Use MP4, MKV, MOV, WebM, AVI, or another common video format.",
        )
    _require_disk_space()
    semaphore: asyncio.Semaphore = request.app.state.upload_sem
    if semaphore.locked():
        raise HTTPException(status_code=429, detail="Too many uploads at once. Wait for the current uploads to finish.")

    async with semaphore:
        upload_root = config.DATA_DIR / "uploads"
        upload_root.mkdir(parents=True, exist_ok=True)
        staging = Path(tempfile.mkdtemp(prefix="library-", dir=upload_root))
        staged_file = staging / f"input{extension}"
        item_id = "lib_" + secrets.token_hex(6)
        version_id = "v_" + secrets.token_hex(6)
        version_dir = config.LIBRARY_DIR / item_id / version_id
        try:
            total = await _stream_upload(file, staged_file)
            if total == 0:
                raise HTTPException(status_code=422, detail="The uploaded file is empty.")
            try:
                meta = await run_in_threadpool(probe_video, str(staged_file))
            except EngineError as exc:
                raise HTTPException(status_code=422, detail=str(exc)) from exc
            version_dir.mkdir(parents=True, exist_ok=True)
            final_video = version_dir / f"video{extension}"
            os.replace(staged_file, final_video)
            thumb_src = staging / "thumb.jpg"
            has_thumb = await run_in_threadpool(make_thumbnail, str(final_video), str(thumb_src))
            final_thumb = None
            if has_thumb:
                final_thumb = version_dir / "thumb.jpg"
                os.replace(thumb_src, final_thumb)
            meta["name"] = original_name
            meta["sizeBytes"] = total
            item = db.create_library_item(
                name=original_name,
                version_id=version_id,
                path=str(final_video),
                thumb_path=str(final_thumb) if final_thumb else None,
                label="Original",
                metadata=meta,
                settings={},
                item_id=item_id,
            )
            log.info("library upload %s (%s, %.1f MB)", item_id, original_name, total / 1e6)
            return db.public_library_item(item)
        except BaseException:
            shutil.rmtree(staging, ignore_errors=True)
            shutil.rmtree(config.LIBRARY_DIR / item_id, ignore_errors=True)
            raise


@app.post("/api/library/{item_id}/activate", status_code=200)
async def api_library_activate(
    item_id: str,
    payload: LibraryActivate,
    db: Database = Depends(get_db),
):
    if not db.set_library_active(item_id, payload.versionId):
        raise HTTPException(status_code=404, detail="library item or version not found")
    item = db.get_library_item(item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="library item not found")
    return db.public_library_item(item)


@app.delete("/api/library/{item_id}", status_code=204)
async def api_library_delete(item_id: str, db: Database = Depends(get_db)):
    item = db.get_library_item(item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="library item not found")
    if db.library_item_busy(item_id):
        raise HTTPException(status_code=409, detail="cancel active jobs for this item before deleting it")
    db.delete_library_item(item_id)
    shutil.rmtree(config.LIBRARY_DIR / item_id, ignore_errors=True)
    return Response(status_code=204)


@app.get("/api/library/{item_id}/versions/{version_id}/stream")
async def api_library_stream(item_id: str, version_id: str, db: Database = Depends(get_db)):
    version = _library_version_for(db, item_id, version_id)
    path = Path(version["path"])
    if not path.exists():
        raise HTTPException(status_code=404, detail="library file is missing")
    name = Path(version["path"]).name
    return FileResponse(path, media_type=_media_type(name), content_disposition_type="inline")


@app.get("/api/library/{item_id}/versions/{version_id}/download")
async def api_library_download(item_id: str, version_id: str, db: Database = Depends(get_db)):
    version = _library_version_for(db, item_id, version_id)
    item = db.get_library_item(item_id)
    path = Path(version["path"])
    if not path.exists():
        raise HTTPException(status_code=404, detail="library file is missing")
    stem = (item or {}).get("name", "video")
    stem = Path(stem).stem
    filename = f"{stem}-{version['label'].replace(' ', '-')}{path.suffix}"
    return FileResponse(path, media_type=_media_type(path.name), filename=filename)


@app.get("/api/library/{item_id}/versions/{version_id}/thumbnail")
async def api_library_thumbnail(item_id: str, version_id: str, db: Database = Depends(get_db)):
    version = _library_version_for(db, item_id, version_id)
    thumb = version.get("thumbPath")
    if not thumb or not Path(thumb).exists():
        raise HTTPException(status_code=404, detail="no thumbnail available")
    return FileResponse(thumb, media_type="image/jpeg")


# ----------------------------------------------------------------- settings


class _SettingsPayload(dict):
    pass


@app.get("/api/settings")
async def api_get_settings(db: Database = Depends(get_db)):
    return _settings_payload(db)


@app.put("/api/settings")
async def api_put_settings(payload: StationSettingsUpdate, db: Database = Depends(get_db)):
    db.save_station_settings(
        {
            "processingMode": payload.processingMode,
            "defaults": payload.defaults.model_dump(),
        }
    )
    return _settings_payload(db)


def _settings_payload(db: Database) -> dict[str, Any]:
    station = db.get_station_settings()
    return {
        "processingMode": station.get("processingMode", "auto"),
        "defaults": station.get("defaults", {}),
        "capabilities": {
            "gpu": gpu_info(),
            "interpolators": system_info(db.queue_counts())["models"]["interpolators"],
        },
        "limits": {
            "maxUploadMb": config.MAX_UPLOAD_MB,
            "minFreeGb": config.MIN_FREE_GB,
            "retentionHours": config.RETENTION_HOURS,
            "maxOutputPixels": config.MAX_OUTPUT_PIXELS,
        },
    }


# ------------------------------------------------------------------ helpers


def _prepare_settings(db: Database, raw: str):
    parsed = parse_settings(raw)
    station = db.get_station_settings()
    mode = station.get("processingMode", "auto")
    if mode not in ("auto", "gpu", "cpu"):
        mode = "auto"
    parsed.processing.mode = mode
    _validate_processing_mode(parsed, mode)
    return parsed, mode


def _validate_processing_mode(parsed, mode: str) -> None:
    if mode == "gpu":
        gpu = gpu_info()
        if parsed.upscale.enabled and parsed.upscale.model == "lanczos":
            raise HTTPException(
                status_code=422,
                detail="GPU-only mode requires an AI upscaler. Choose Real-ESRGAN or switch to Auto/CPU.",
            )
        if parsed.upscale.enabled and not gpu.get("vulkan"):
            raise HTTPException(
                status_code=422,
                detail=(
                    "GPU-only mode requires Vulkan for the Real-ESRGAN upscaler. "
                    "Install the NVIDIA Vulkan driver or switch to Auto/CPU."
                ),
            )
        if parsed.interpolate.enabled:
            spec = INTERPOLATORS[parsed.interpolate.model]
            if spec.engine == "ncnn" and not gpu.get("vulkan"):
                raise HTTPException(
                    status_code=422,
                    detail=(
                        f"GPU-only mode requires Vulkan for {spec.label}. "
                        "Install the NVIDIA Vulkan driver or switch to Auto/CPU."
                    ),
                )
            if spec.engine == "onnx" and not gpu.get("cudaOnnx"):
                raise HTTPException(
                    status_code=422,
                    detail=(
                        "GPU-only mode can run RIFE 4.27 only with CUDA ONNX Runtime. "
                        "Choose RIFE 4.26 or older (Vulkan), or switch to Auto."
                    ),
                )
    elif mode == "cpu":
        if parsed.upscale.enabled and parsed.upscale.model != "lanczos":
            raise HTTPException(
                status_code=422,
                detail="CPU-only mode uses Lanczos scaling. Choose Lanczos or switch to Auto/GPU.",
            )


async def _stream_upload(file: UploadFile, destination: Path) -> int:
    total = 0
    with open(destination, "wb") as output:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > config.MAX_UPLOAD_BYTES:
                raise HTTPException(
                    status_code=413,
                    detail=f"Upload is larger than the {config.MAX_UPLOAD_MB} MB limit.",
                )
            output.write(chunk)
    await file.close()
    return total


def _link_or_copy(source: Path, destination: Path) -> None:
    try:
        os.link(source, destination)
    except OSError:
        shutil.copy2(source, destination)


def _library_version_for(db: Database, item_id: str, version_id: str) -> dict[str, Any]:
    version = db.get_library_version(version_id)
    if version is None or version["itemId"] != item_id:
        raise HTTPException(status_code=404, detail="library version not found")
    return version


def _media_type(name: str) -> str:
    lower = name.lower()
    if lower.endswith(".mkv"):
        return "video/x-matroska"
    if lower.endswith(".webm"):
        return "video/webm"
    return "video/mp4"


def _queue_payload(db: Database) -> dict[str, int]:
    counts = db.queue_counts()
    return {
        "active": counts["active"],
        "queued": counts["queued"],
        "maxActive": config.MAX_ACTIVE_JOBS,
        "maxQueue": config.MAX_QUEUE,
    }


def _require_disk_space() -> None:
    usage = shutil.disk_usage(config.DATA_DIR)
    free_gb = usage.free / (1024 ** 3)
    if free_gb < config.MIN_FREE_GB:
        raise HTTPException(
            status_code=507,
            detail=(
                f"Only {free_gb:.1f} GB free on the server; "
                f"{config.MIN_FREE_GB:.0f} GB is required. Remove old jobs and retry."
            ),
        )


def _validate_output_size(meta: dict[str, Any], settings) -> None:
    scale = settings.upscale.scale if settings.upscale.enabled else 1
    width = int(meta["width"]) * scale
    height = int(meta["height"]) * scale
    if width * height > config.MAX_OUTPUT_PIXELS:
        raise HTTPException(
            status_code=422,
            detail=(
                f"The projected output is {width}×{height}, above the 3840×2160 "
                "stability limit. Use a smaller scale or a smaller source."
            ),
        )


@app.api_route("/api/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
async def api_unknown(path: str):
    raise HTTPException(status_code=404, detail="API endpoint not found")


# The console is served last so /api and /health always win route resolution.
if config.FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(config.FRONTEND_DIR), html=True), name="frontend")
else:  # pragma: no cover - only in backend-only development
    @app.get("/", response_class=HTMLResponse)
    async def missing_frontend():
        return HTMLResponse(
            "<h1>RVEWeb API is running</h1><p>The frontend build was not found.</p>",
            status_code=200,
        )


if __name__ == "__main__":  # pragma: no cover
    import uvicorn

    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=int(os.environ.get("PORT", "8080")),
        workers=1,
        limit_concurrency=128,
    )
