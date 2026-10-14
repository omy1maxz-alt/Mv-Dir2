# Video Enhancer GPU Worker (backend scaffold)

This directory defines a first API contract for the Enhancer tab. It deliberately does **not** claim to enhance footage until a real model adapter is installed. The first iteration accepts uploads, validates requests, tracks an explicit blocked state, and provides job-status/cancel/result routes. It is suitable for wiring and deployment smoke tests, not production video processing.

## API

- `GET /health` — health and model readiness (currently `model_ready: false`).
- `POST /v1/jobs` — authenticated multipart upload and JSON settings in `X-Enhancement-Settings`.
- `GET /v1/jobs/{job_id}` — status.
- `POST /v1/jobs/{job_id}/cancel` — cancellation.
- `GET /v1/jobs/{job_id}/result` — returns 409 until a model adapter created a real MP4.

All API routes except `/health` require `Authorization: Bearer <VIDEO_WORKER_API_KEY>`.

## Run locally

```bash
cd services/video-enhancer-worker
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
export VIDEO_WORKER_API_KEY='replace-with-a-long-random-secret'
uvicorn app:app --host 127.0.0.1 --port 8080
```

Docker smoke test:

```bash
docker build -t clarity-video-worker services/video-enhancer-worker
docker run --rm -p 8080:8080 -e VIDEO_WORKER_API_KEY='replace-me' clarity-video-worker
```

## Before production

1. Replace in-memory job state with Redis/PostgreSQL or a managed job queue. Current state is lost on restart and does not work across replicas.
2. Move incoming and completed assets to private object storage using signed URLs; local disk is only a development scaffold.
3. Implement a queue consumer/GPU worker and a genuine model adapter. Keep the API and GPU process separate for long jobs.
4. Add FFmpeg probing, codec/duration/pixel limits, isolated transcoding, per-user authorization/quotas, rate limiting, retention cleanup, and audit-safe logs.
5. Confirm model weights, CUDA/PyTorch compatibility, and licenses before commercial use.
6. Configure secrets only in your hosting provider; never commit keys or expose them in frontend bundles.
7. Set API CORS, TLS, authentication, and storage ownership rules for your deployment environment.

## Model adapter contract

A processing implementation should accept a source path plus validated `EnhancementSettings`, run real inference, and return an actual MP4 path with verified duration, frame rate, dimensions and audio policy. Suggested candidates for evaluation: Real-ESRGAN for image super-resolution, BasicVSR++ for temporal video restoration, RIFE for interpolation, and FFmpeg for media muxing. No model is bundled by default.
