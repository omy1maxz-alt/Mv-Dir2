# Clarity Video Worker API scaffold

The FastAPI service is an API contract and development scaffold. It is **not yet a video enhancer**: `GET /health` returns `model_ready: false`, and newly uploaded jobs enter `blocked` instead of pretending that inference occurred.

## Endpoints

- `GET /health` — liveness and model readiness.
- `POST /v1/jobs` — authenticated multipart upload; settings are JSON in `X-Enhancement-Settings`.
- `GET /v1/jobs/{job_id}` — fetch job state.
- `POST /v1/jobs/{job_id}/cancel` — cancel a non-terminal job.
- `GET /v1/jobs/{job_id}/result` — returns a real MP4 only after a configured adapter has marked a result available.

All endpoints other than `/health` require `Authorization: Bearer <VIDEO_WORKER_API_KEY>`.

## Local development

```bash
cd services/video-enhancer-worker
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
export VIDEO_WORKER_API_KEY='replace-with-a-long-random-secret'
uvicorn app:app --host 127.0.0.1 --port 8080
```

## Production prerequisites

1. Put a trusted server-side gateway in front of the worker. Do not send the worker API key to browser code or expose it through a `VITE_*` variable.
2. Replace in-memory job records and local disk with a durable queue/database and private object storage using short-lived signed URLs.
3. Implement a GPU model adapter in a separate worker process. This API intentionally contains no placeholder transcoding that could be mistaken for AI restoration.
4. Apply authentication and per-user ownership on every job, request limits, quotas, timeouts, retention cleanup, private network/TLS, and FFmpeg sandbox/resource limits.
5. Add a real health/readiness check for CUDA, weights, and model warm-up, then verify output metadata and original-audio behavior.
6. Check the licenses and compatibility of all model code and weights before commercial use.

Possible model candidates to evaluate include Real-ESRGAN for image super-resolution, BasicVSR++ for temporal video restoration, RIFE for interpolation, and FFmpeg for media inspection/encoding. No model weights are bundled or implied to be installed.
