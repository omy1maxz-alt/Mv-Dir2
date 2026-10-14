"""Clarity video-enhancement worker API.

This service is a safe integration scaffold, not a functioning AI enhancer until
a model implementation and cloud object-storage adapter are configured.
"""
from __future__ import annotations

import os
import re
import secrets
import shutil
import tempfile
import time
from pathlib import Path
from typing import Literal
from uuid import uuid4

from fastapi import BackgroundTasks, FastAPI, File, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

APP_NAME = "Clarity Video Worker"
API_KEY = os.getenv("VIDEO_WORKER_API_KEY", "")
MAX_UPLOAD_MB = int(os.getenv("VIDEO_WORKER_MAX_UPLOAD_MB", "512"))
MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024
WORK_DIR = Path(os.getenv("VIDEO_WORK_DIR", "/tmp/clarity-video-worker"))
WORK_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title=APP_NAME, version="0.1.0")
JOBS: dict[str, dict] = {}
FILES: dict[str, Path] = {}


class EnhancementSettings(BaseModel):
    scale: Literal["original", "1080p", "1440p", "4k"] = "1080p"
    preset: Literal["faithful", "old", "compressed", "animation", "lowlight"] = "faithful"
    denoise: Literal["off", "low", "medium", "high"] = "low"
    sharpen: Literal["off", "low", "medium", "high"] = "low"
    face_restore: bool = False
    interpolate: bool = False


def authorize(authorization: str | None) -> None:
    if not API_KEY:
        raise HTTPException(503, "Worker API is not configured. Set VIDEO_WORKER_API_KEY.")
    expected = f"Bearer {API_KEY}"
    if not authorization or not secrets.compare_digest(authorization, expected):
        raise HTTPException(401, "Invalid worker credentials.")


def get_job(job_id: str) -> dict:
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found.")
    return job


@app.get("/health")
def health():
    return {
        "ok": True,
        "service": APP_NAME,
        "model_ready": False,
        "message": "Worker scaffold is online; no model adapter is configured."
    }


@app.post("/v1/jobs", status_code=202)
async def create_job(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    settings: str = Header(default="{}", alias="X-Enhancement-Settings"),
    authorization: str | None = Header(default=None),
):
    authorize(authorization)
    import json

    try:
        parsed = EnhancementSettings.model_validate(json.loads(settings))
    except Exception as exc:
        raise HTTPException(400, "X-Enhancement-Settings must be valid enhancement settings JSON.") from exc

    filename = Path(file.filename or "video.mp4").name
    if not re.search(r"\.(mp4|mov|webm|m4v|avi|mkv)$", filename, re.IGNORECASE):
        raise HTTPException(415, "Unsupported video extension.")
    job_id = str(uuid4())
    source_path = WORK_DIR / f"{job_id}-source{Path(filename).suffix.lower()}"
    total = 0
    try:
        with source_path.open("wb") as output:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_UPLOAD_BYTES:
                    raise HTTPException(413, f"Video exceeds the {MAX_UPLOAD_MB} MB upload limit.")
                output.write(chunk)
    except Exception:
        source_path.unlink(missing_ok=True)
        raise
    finally:
        await file.close()

    # We intentionally do not mark a job as enhanced. A model adapter must be
    # configured before processing can start, to avoid fake/unchanged exports.
    JOBS[job_id] = {
        "job_id": job_id,
        "status": "blocked",
        "progress": 0,
        "stage": "model_not_configured",
        "message": "Upload received, but AI model adapter is not configured. No output was generated.",
        "filename": filename,
        "size_bytes": total,
        "settings": parsed.model_dump(),
        "created_at": int(time.time()),
        "result_available": False,
    }
    FILES[job_id] = source_path
    return JOBS[job_id]


@app.get("/v1/jobs/{job_id}")
def job_status(job_id: str, authorization: str | None = Header(default=None)):
    authorize(authorization)
    return get_job(job_id)


@app.post("/v1/jobs/{job_id}/cancel")
def cancel_job(job_id: str, authorization: str | None = Header(default=None)):
    authorize(authorization)
    job = get_job(job_id)
    if job["status"] in ("completed", "failed", "cancelled"):
        return job
    job.update(status="cancelled", stage="cancelled", message="Job cancelled.", progress=0)
    return job


@app.get("/v1/jobs/{job_id}/result")
def job_result(job_id: str, authorization: str | None = Header(default=None)):
    authorize(authorization)
    job = get_job(job_id)
    if not job.get("result_available") or not job.get("result_path"):
        raise HTTPException(409, "No enhanced result is available for this job.")
    path = Path(job["result_path"])
    if not path.is_file():
        raise HTTPException(404, "Result file is no longer available.")
    return FileResponse(path, media_type="video/mp4", filename=f"enhanced-{job_id}.mp4")
