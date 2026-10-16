import os
from fastapi.testclient import TestClient

os.environ.setdefault("VIDEO_WORKER_API_KEY", "test-secret")

from app import app  # noqa: E402

client = TestClient(app)
AUTH = {"Authorization": "Bearer test-secret"}


def test_health_explicitly_reports_model_not_ready():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert response.json()["model_ready"] is False


def test_private_routes_require_authentication():
    response = client.get("/v1/jobs/not-a-job")
    assert response.status_code == 401


def test_upload_rejects_wrong_extension(tmp_path, monkeypatch):
    monkeypatch.setattr("app.WORK_DIR", tmp_path)
    response = client.post(
        "/v1/jobs",
        headers={**AUTH, "X-Enhancement-Settings": '{"scale":"1080p"}'},
        files={"file": ("not-video.txt", b"no video", "text/plain")},
    )
    assert response.status_code == 415


def test_upload_rejects_invalid_settings():
    response = client.post(
        "/v1/jobs",
        headers={**AUTH, "X-Enhancement-Settings": '{"scale":"9999p"}'},
        files={"file": ("clip.mp4", b"fake video fixture", "video/mp4")},
    )
    assert response.status_code == 400


def test_upload_creates_blocked_job_not_fake_output(tmp_path, monkeypatch):
    monkeypatch.setattr("app.WORK_DIR", tmp_path)
    response = client.post(
        "/v1/jobs",
        headers={**AUTH, "X-Enhancement-Settings": '{"scale":"1080p","preset":"faithful"}'},
        files={"file": ("clip.mp4", b"fake video fixture", "video/mp4")},
    )
    assert response.status_code == 202
    payload = response.json()
    assert payload["status"] == "blocked"
    assert payload["result_available"] is False
    assert payload["stage"] == "model_not_configured"


def test_result_is_unavailable_until_real_output_exists():
    response = client.get("/v1/jobs/unknown/result", headers=AUTH)
    assert response.status_code == 404
