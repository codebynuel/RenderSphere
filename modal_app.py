import hmac
import os
import time

import modal
from fastapi import Header, HTTPException


app = modal.App("rendersphere")
worker_secrets = [modal.Secret.from_name("rendersphere-worker-env")]
gateway_secrets = [modal.Secret.from_name("rendersphere-modal-gateway")]
cpu_test_mode = os.environ.get("RENDERSPHERE_MODAL_CPU_TEST", "").strip().lower() == "true"
worker_gpu = None if cpu_test_mode else "L40S"

worker_image = (
    modal.Image.from_registry(
        "nvidia/cuda:12.4.1-base-ubuntu22.04",
        add_python="3.11",
    )
    .apt_install(
        "ca-certificates",
        "python3-pip",
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
        "wget",
    )
    .run_commands(
        "wget -q https://download.blender.org/release/Blender4.4/blender-4.4.3-linux-x64.tar.xz -O /tmp/blender.tar.xz"
        " && tar -xf /tmp/blender.tar.xz -C /opt"
        " && mv /opt/blender-4.4.3-linux-x64 /opt/blender"
        " && ln -s /opt/blender/blender /usr/local/bin/blender"
        " && rm /tmp/blender.tar.xz"
    )
    .pip_install("boto3", "fastapi")
    .add_local_python_source("handler")
)

gateway_image = modal.Image.debian_slim(python_version="3.11").pip_install("fastapi")


@app.function(
    image=worker_image,
    gpu=worker_gpu,
    max_containers=20,
    timeout=21600,
    retries=0,
    secrets=worker_secrets,
)
def render(input_data: dict) -> dict:
    if cpu_test_mode:
        os.environ["RENDER_FORCE_CPU"] = "true"
        os.environ["RENDER_ALLOW_CPU_FALLBACK"] = "true"

    backend_url = input_data.get("backendUrl")
    if isinstance(backend_url, str) and backend_url.strip():
        os.environ["RENDERSPHERE_BACKEND_URL"] = backend_url.rstrip("/")

    from handler import render_job

    os.environ.setdefault("CUDA_CACHE_PATH", "/tmp/cuda-cache")
    os.environ.setdefault("CUDA_MODULE_LOADING", "LAZY")
    os.environ.setdefault("NVIDIA_DRIVER_CAPABILITIES", "compute,utility,graphics")
    os.environ.setdefault("RENDER_GPU_DEVICE_TYPE", "AUTO")
    os.environ.setdefault("RENDER_ALLOW_CPU_FALLBACK", "false")
    os.environ.setdefault("RENDER_FORCE_CPU", "false")

    dispatch_reference = input_data.get("dispatchReference")
    if not isinstance(dispatch_reference, str) or not dispatch_reference:
        raise ValueError("dispatchReference is required")

    started_at = time.monotonic()
    result = render_job({"id": dispatch_reference, "input": input_data})
    if result.get("status") != "success" or not result.get("result_key"):
        raise RuntimeError("Render worker returned no completed result")

    return {
        **result,
        "executionTimeMs": max(1, round((time.monotonic() - started_at) * 1000)),
    }


def _authorize(authorization: str) -> None:
    expected = os.environ.get("MODAL_API_SECRET", "")
    scheme, separator, token = authorization.partition(" ")
    if not expected or not separator or scheme.lower() != "bearer" or not hmac.compare_digest(token, expected):
        raise HTTPException(status_code=401, detail="Unauthorized")


@app.function(image=gateway_image, secrets=gateway_secrets, timeout=60)
@modal.fastapi_endpoint(method="POST")
def render_gateway(payload: dict, authorization: str = Header(default="")) -> dict:
    _authorize(authorization)
    action = payload.get("action")

    if action == "submit":
        input_data = payload.get("input")
        if not isinstance(input_data, dict):
            raise HTTPException(status_code=400, detail="input must be a JSON object")
        call = render.spawn(input_data)
        return {"id": call.object_id, "status": "IN_QUEUE"}

    call_id = payload.get("id")
    if not isinstance(call_id, str) or not call_id:
        raise HTTPException(status_code=400, detail="id is required")

    call = modal.FunctionCall.from_id(call_id)
    if action == "status":
        try:
            result = call.get(timeout=0)
        except TimeoutError:
            return {"id": call_id, "status": "IN_PROGRESS"}
        except Exception as error:
            print(f"Modal render failed for {call_id}: {error}")
            return {
                "id": call_id,
                "status": "FAILED",
                "error": "Render failed while processing the scene.",
            }

        if not isinstance(result, dict) or result.get("status") != "success" or not result.get("result_key"):
            return {
                "id": call_id,
                "status": "FAILED",
                "error": "Render failed while processing the scene.",
            }
        return {
            "id": call_id,
            "status": "COMPLETED",
            "output": result,
            "executionTimeMs": result.get("executionTimeMs"),
        }

    if action == "cancel":
        try:
            result = call.get(timeout=0)
        except TimeoutError:
            result = None
        except Exception as error:
            raise HTTPException(status_code=409, detail="Render is no longer active") from error
        if result is not None:
            return {
                "id": call_id,
                "status": "COMPLETED",
                "output": result,
                "executionTimeMs": result.get("executionTimeMs") if isinstance(result, dict) else None,
            }
        try:
            call.cancel(terminate_containers=True)
        except Exception as error:
            print(f"Modal cancellation failed for {call_id}: {error}")
            raise HTTPException(status_code=502, detail="Failed to cancel render") from error
        return {"id": call_id, "status": "CANCELLED"}

    raise HTTPException(status_code=400, detail="Unsupported action")
