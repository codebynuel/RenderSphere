import os
import secrets
import time
import traceback

import modal

APP_NAME = "rendersphere-render-worker"
BLENDER_VERSION = "4.0.2"
TERMINAL_STATUSES = {"COMPLETED", "FAILED", "CANCELLED"}

image = (
    modal.Image.from_registry("nvidia/cuda:12.1.1-base-ubuntu22.04", add_python="3.11")
    .apt_install(
        "ca-certificates",
        "wget",
        "xz-utils",
        "libxrender1",
        "libxi6",
        "libxkbcommon0",
        "libx11-6",
        "libgl1",
        "libgl1-mesa-glx",
        "libglu1-mesa",
        "libegl1",
        "libsm6",
        "libxext6",
        "libxfixes3",
        "libxxf86vm1",
        "libxrandr2",
        "libxinerama1",
        "libxcursor1",
        "libfontconfig1",
        "libfreetype6",
        "libdbus-1-3",
    )
    .run_commands(
        f"wget https://download.blender.org/release/Blender4.0/blender-{BLENDER_VERSION}-linux-x64.tar.xz",
        f"tar -xvf blender-{BLENDER_VERSION}-linux-x64.tar.xz -C /opt/",
        f"mv /opt/blender-{BLENDER_VERSION}-linux-x64 /opt/blender",
        "ln -s /opt/blender/blender /usr/local/bin/blender",
        f"rm blender-{BLENDER_VERSION}-linux-x64.tar.xz",
    )
    .pip_install("boto3", "fastapi")
    .env({
        "CUDA_CACHE_PATH": "/tmp/cuda-cache",
        "CUDA_MODULE_LOADING": "LAZY",
        "NVIDIA_VISIBLE_DEVICES": "all",
        "NVIDIA_DRIVER_CAPABILITIES": "compute,utility,graphics",
        "RENDER_GPU_DEVICE_TYPE": "AUTO",
        "RENDER_ALLOW_CPU_FALLBACK": "false",
        "RENDER_FORCE_CPU": "false",
    })
)

app = modal.App(APP_NAME, image=image)
worker_secret = modal.Secret.from_name("rendersphere-worker-env")
api_secret = modal.Secret.from_name("rendersphere-modal-api", required_keys=["MODAL_RENDER_TOKEN"])
job_store = modal.Dict.from_name("rendersphere-render-jobs", create_if_missing=True)


def _now():
    return time.time()


def _normalize_token_header(value):
    if not value:
        return ""
    value = str(value).strip()
    if value.lower().startswith("bearer "):
        return value[7:].strip()
    return value


def _authorize(request):
    from fastapi import HTTPException

    expected = os.environ.get("MODAL_RENDER_TOKEN")
    if not expected:
        return
    provided = _normalize_token_header(request.headers.get("authorization"))
    if not secrets.compare_digest(provided, expected):
        raise HTTPException(status_code=401, detail="Unauthorized")


def _get_job(job_id):
    return dict(job_store.get(job_id, {}) or {})


def _public_job(job_id):
    job = _get_job(job_id)
    if not job:
        return None
    job.pop("cancel_requested", None)
    job.pop("input", None)
    return job


def _update_job(job_id, **updates):
    current = _get_job(job_id)
    current.update(updates)
    current["updatedAt"] = _now()
    job_store[job_id] = current
    return current


def _is_cancel_requested(job_id):
    return bool(_get_job(job_id).get("cancel_requested"))


@app.function(secrets=[worker_secret], gpu="any", timeout=21600, scaledown_window=300, max_containers=10)
def render_job_modal(job_id, job_input):
    from render_worker import render_blender_job

    started = _now()
    _update_job(job_id, status="IN_PROGRESS", startedAt=started, progress={"percent": 4})

    def progress_callback(progress):
        _update_job(job_id, progress=progress)

    try:
        output = render_blender_job(
            job_input,
            job_id=job_id,
            progress_callback=progress_callback,
            should_cancel=lambda: _is_cancel_requested(job_id),
        )
        finished = _now()
        _update_job(
            job_id,
            status="COMPLETED",
            output=output,
            result_key=output.get("result_key"),
            resultKey=output.get("result_key"),
            executionSeconds=max(1, int(finished - started)),
            progress={"percent": 100},
            completedAt=finished,
        )
    except Exception as exc:
        finished = _now()
        cancelled = _is_cancel_requested(job_id)
        _update_job(
            job_id,
            status="CANCELLED" if cancelled else "FAILED",
            error=str(exc),
            output={"error": str(exc)},
            executionSeconds=max(1, int(finished - started)),
            failedAt=None if cancelled else finished,
            cancelledAt=finished if cancelled else None,
            traceback=traceback.format_exc()[-4000:],
        )


@app.function(secrets=[api_secret], timeout=60, scaledown_window=300)
@modal.asgi_app()
def web_app():
    from fastapi import FastAPI, HTTPException, Request

    api = FastAPI()

    @api.post("/render")
    async def render(request: Request):
        _authorize(request)
        body = await request.json()
        job_input = body.get("input") if isinstance(body.get("input"), dict) else body
        job_id = f"modal-{secrets.token_hex(12)}"

        job_store[job_id] = {
            "id": job_id,
            "status": "SUBMITTED",
            "input": job_input,
            "progress": {"percent": 2},
            "createdAt": _now(),
            "updatedAt": _now(),
            "cancel_requested": False,
        }
        render_job_modal.spawn(job_id, job_input)
        return {"id": job_id, "status": "SUBMITTED", "progress": {"percent": 2}}

    @api.get("/status/{job_id}")
    async def status(job_id: str, request: Request):
        _authorize(request)
        job = _public_job(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Job not found")
        return job

    @api.delete("/cancel/{job_id}")
    async def cancel(job_id: str, request: Request):
        _authorize(request)
        job = _get_job(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Job not found")
        if job.get("status") not in TERMINAL_STATUSES:
            job["cancel_requested"] = True
            job["status"] = "CANCELLED"
            job["cancelledAt"] = _now()
            job["updatedAt"] = _now()
            job_store[job_id] = job
        return _public_job(job_id)

    return api
