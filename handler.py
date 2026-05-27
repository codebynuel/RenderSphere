import runpod
import boto3
import subprocess
import os
import shutil
import re
import time
import glob
import select

REQUIRED_ENV_VARS = [
    'R2_ENDPOINT',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'R2_BUCKET_NAME',
]
BLENDER_FATAL_PATTERNS = (
    'segmentation fault',
    'signal 6',
    'sigabrt',
    'abort',
    'out of memory',
    'cuda error',
    'optix error',
)

def positive_int_env(name, default):
    try:
        value = int(os.environ.get(name, str(default)))
    except ValueError:
        return default
    return value if value > 0 else default


RENDER_TIMEOUT_SECONDS = positive_int_env('RENDER_TIMEOUT_SECONDS', 21600)
MIN_TMP_FREE_MB = positive_int_env('RENDER_MIN_TMP_FREE_MB', 1024)


def validate_required_env():
    missing = [name for name in REQUIRED_ENV_VARS if not os.environ.get(name)]
    if missing:
        raise RuntimeError(f"Missing required environment variables: {', '.join(missing)}")


validate_required_env()

s3 = boto3.client(
    's3',
    endpoint_url=os.environ.get('R2_ENDPOINT'),
    aws_access_key_id=os.environ.get('R2_ACCESS_KEY_ID'),
    aws_secret_access_key=os.environ.get('R2_SECRET_ACCESS_KEY'),
    region_name='auto'
)

BUCKET_NAME = os.environ.get('R2_BUCKET_NAME')

VALID_OUTPUT_FORMATS = {'PNG', 'JPEG', 'OPEN_EXR', 'OPEN_EXR_MULTILAYER'}
VALID_DENOISERS = {'NONE', 'OPTIX', 'OPENIMAGEDENOISE'}
OUTPUT_EXTENSIONS = {
    'PNG': 'png',
    'JPEG': 'jpg',
    'OPEN_EXR': 'exr',
    'OPEN_EXR_MULTILAYER': 'exr',
}


def clamp_int(value, minimum, maximum, default):
    try:
        number_value = int(value)
    except (TypeError, ValueError):
        return default
    return min(max(number_value, minimum), maximum)


def clamp_float(value, minimum, maximum, default):
    try:
        number_value = float(value)
    except (TypeError, ValueError):
        return default
    return min(max(number_value, minimum), maximum)


def get_first(job_input, *keys, default=None):
    for key in keys:
        if key in job_input:
            return job_input.get(key)
    return default


def normalize_choice(value, valid_values, default):
    normalized = str(value or default).upper()
    return normalized if normalized in valid_values else default


def normalize_bool(value, default=False):
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {'1', 'true', 'yes', 'on'}
    return default


def normalize_name(value):
    if value is None:
        return None
    normalized = str(value).strip()
    return normalized or None


def ensure_tmp_space(stage):
    usage = shutil.disk_usage('/tmp')
    free_mb = usage.free // (1024 * 1024)
    if free_mb < MIN_TMP_FREE_MB:
        raise RuntimeError(
            f"Not enough /tmp disk space before {stage}: {free_mb} MB free, "
            f"{MIN_TMP_FREE_MB} MB required"
        )
    print(f"/tmp free before {stage}: {free_mb} MB")


def build_blender_setup_script(engine, samples, output_format, resolution_pct, denoiser, noise_threshold, camera, scene_name, force_cpu, allow_cpu_fallback, gpu_device_type):
    return f"""
import bpy

engine = {engine!r}
samples = {samples}
output_format = {output_format!r}
resolution_pct = {resolution_pct}
denoiser = {denoiser!r}
noise_threshold = {noise_threshold}
camera_name = {camera!r}
scene_name = {scene_name!r}
force_cpu = {force_cpu!r}
allow_cpu_fallback = {allow_cpu_fallback!r}
requested_gpu_device_type = {gpu_device_type!r}

target_scene = bpy.data.scenes.get(scene_name) if scene_name else bpy.context.scene
if scene_name and target_scene is None:
    raise ValueError(f"Scene '{{scene_name}}' was not found in the blend file")

scene = target_scene or bpy.context.scene
for window in bpy.context.window_manager.windows:
    window.scene = scene

if camera_name:
    camera_object = bpy.data.objects.get(camera_name)
    if camera_object is None:
        raise ValueError(f"Camera '{{camera_name}}' was not found in the blend file")
    if camera_object.type != 'CAMERA':
        raise ValueError(f"Object '{{camera_name}}' is not a camera")
    scene.camera = camera_object

if scene.camera:
    print(f"Rendering scene '{{scene.name}}' with camera '{{scene.camera.name}}'")
else:
    print(f"Rendering scene '{{scene.name}}' without an explicit camera")

scene.render.engine = engine
scene.render.image_settings.file_format = output_format
scene.render.resolution_percentage = resolution_pct

if engine == 'CYCLES':
    scene.cycles.samples = samples
    scene.cycles.use_denoising = denoiser != 'NONE'
    if denoiser != 'NONE':
        try:
            scene.cycles.denoiser = denoiser
        except Exception as exc:
            print(f"Could not set Cycles denoiser {{denoiser}}: {{exc}}")

    if hasattr(scene.cycles, 'use_adaptive_sampling'):
        scene.cycles.use_adaptive_sampling = noise_threshold > 0.0
    if hasattr(scene.cycles, 'adaptive_threshold'):
        scene.cycles.adaptive_threshold = noise_threshold

    def use_cpu(reason):
        if force_cpu or allow_cpu_fallback:
            scene.cycles.device = 'CPU'
            print(f"Cycles CPU rendering enabled: {{reason}}")
            return
        raise RuntimeError(
            f"GPU render device setup failed: {{reason}}. "
            "Attach an NVIDIA GPU worker or set RENDER_ALLOW_CPU_FALLBACK=true for diagnostics."
        )

    if force_cpu:
        use_cpu('forced by worker configuration')
    else:
        try:
            scene.cycles.device = 'GPU'
            prefs = bpy.context.preferences
            cycles_addon = prefs.addons.get('cycles')
            if not cycles_addon:
                raise RuntimeError('Cycles add-on preferences are unavailable')
            cprefs = cycles_addon.preferences

            def refresh_devices():
                if hasattr(cprefs, 'refresh_devices'):
                    cprefs.refresh_devices()
                else:
                    cprefs.get_devices()

            def enable_devices(device_type):
                try:
                    cprefs.compute_device_type = device_type
                    refresh_devices()
                except Exception as exc:
                    print(f"Could not select {{device_type}} devices: {{exc}}")
                    return False

                selected = []
                for device in cprefs.devices:
                    should_use = device.type == device_type and device.type != 'CPU'
                    device.use = should_use
                    if should_use:
                        selected.append(getattr(device, 'name', device.type))

                if selected:
                    print(f"Enabled Cycles {{device_type}} devices: {{', '.join(selected)}}")
                return bool(selected)

            requested = (requested_gpu_device_type or 'AUTO').upper()
            if requested in {'OPTIX', 'CUDA'}:
                device_order = [requested] + [device for device in ['OPTIX', 'CUDA'] if device != requested]
            else:
                device_order = ['OPTIX', 'CUDA']

            enabled = False
            for device_type in device_order:
                if enable_devices(device_type):
                    enabled = True
                    break

            if not enabled:
                use_cpu('no compatible NVIDIA Cycles device was found')
        except Exception as exc:
            use_cpu(f'GPU setup failed: {{exc}}')
else:
    try:
        scene.eevee.taa_render_samples = samples
    except Exception as exc:
        print(f"Could not set Eevee render samples: {{exc}}")

    try:
        bpy.context.preferences.system.use_gpu_subdivision = True
    except Exception:
        pass
"""


def find_rendered_frame(output_dir, start_frame, extension):
    frame_str = str(start_frame).zfill(4)
    expected_file = os.path.join(output_dir, f'frame_{frame_str}.{extension}')
    if os.path.exists(expected_file):
        return expected_file

    matches = glob.glob(os.path.join(output_dir, f'frame_{frame_str}.*'))
    if matches:
        return matches[0]

    raise FileNotFoundError(f"Rendered frame not found for frame {frame_str}")


def stream_blender_process(process, job, start_frame, end_frame, samples, is_animation):
    deadline = time.time() + RENDER_TIMEOUT_SECONDS
    last_update_time = 0
    current_frame_val = start_frame
    current_sample_val = 0
    frame_count = max(1, end_frame - start_frame + 1 if is_animation else 1)
    recent_output = []

    def progress_percent():
        sample_ratio = min(1.0, max(0.0, current_sample_val / max(1, samples)))
        if is_animation:
            frame_index = min(frame_count - 1, max(0, current_frame_val - start_frame))
            return min(99, int(((frame_index + sample_ratio) / frame_count) * 100))
        return min(99, int(sample_ratio * 100))

    while True:
        if time.time() > deadline:
            process.kill()
            raise TimeoutError(f"Blender render exceeded {RENDER_TIMEOUT_SECONDS} seconds")

        ready, _, _ = select.select([process.stdout], [], [], 0.5)
        if ready:
            line = process.stdout.readline()
            if line:
                print(line, end='')
                recent_output.append(line.strip())
                recent_output = recent_output[-24:]

                frame_match = re.search(r'Fra:(\d+)', line)
                sample_match = re.search(r'Sample (\d+)/', line)

                changed = False
                if frame_match:
                    current_frame_val = int(frame_match.group(1))
                    changed = True
                if sample_match:
                    current_sample_val = int(sample_match.group(1))
                    changed = True

                now = time.time()
                if changed and (now - last_update_time > 2.0):
                    runpod.serverless.progress_update(job, {
                        "current_frame": current_frame_val,
                        "current_sample": current_sample_val,
                        "percent": progress_percent(),
                    })
                    last_update_time = now

        if process.poll() is not None:
            for line in process.stdout:
                print(line, end='')
                recent_output.append(line.strip())
                recent_output = recent_output[-24:]
            break

    if process.returncode != 0:
        tail = "\n".join(line for line in recent_output if line)
        tail_lower = tail.lower()
        if process.returncode < 0:
            signal_number = abs(process.returncode)
            likely_reason = "out of memory" if "out of memory" in tail_lower else "native Blender/GPU failure"
            raise RuntimeError(
                f"Blender stopped unexpectedly with signal {signal_number} ({likely_reason}). "
                "Recent Blender output:\n"
                f"{tail[-2000:]}"
            )
        matched_reason = next((pattern for pattern in BLENDER_FATAL_PATTERNS if pattern in tail_lower), "render process failure")
        raise RuntimeError(
            f"Blender stopped with exit code {process.returncode} ({matched_reason}). "
            "Recent Blender output:\n"
            f"{tail[-2000:]}"
        )

    runpod.serverless.progress_update(job, {
        "current_frame": end_frame if is_animation else start_frame,
        "current_sample": samples,
        "percent": 100,
    })


def render_job(job):
    job_input = job['input']

    file_key = normalize_name(job_input.get('fileKey') or job_input.get('file_key'))
    if not file_key:
        raise ValueError("fileKey is required")

    engine = normalize_choice(job_input.get('engine', 'CYCLES'), {'CYCLES', 'BLENDER_EEVEE_NEXT'}, 'CYCLES')
    samples = clamp_int(job_input.get('samples', 256), 1, 8192, 256)

    is_animation = normalize_bool(get_first(job_input, 'isAnimation', 'is_animation', default=False), False)
    start_frame = clamp_int(get_first(job_input, 'startFrame', 'start_frame', default=1), 0, 1000000, 1)
    requested_end_frame = clamp_int(get_first(job_input, 'endFrame', 'end_frame', default=start_frame), 0, 1000000, start_frame)
    end_frame = requested_end_frame if is_animation else start_frame

    output_format = normalize_choice(
        get_first(job_input, 'output_format', 'outputFormat', default='PNG'),
        VALID_OUTPUT_FORMATS,
        'PNG'
    )
    resolution_pct = clamp_int(
        get_first(job_input, 'resolution_pct', 'resolutionPct', default=100),
        1,
        200,
        100
    )
    denoiser = normalize_choice(job_input.get('denoiser', 'NONE'), VALID_DENOISERS, 'NONE')
    noise_threshold = clamp_float(
        get_first(job_input, 'noise_threshold', 'noiseThreshold', default=0.0),
        0.0,
        1.0,
        0.0
    )
    camera = normalize_name(get_first(job_input, 'camera', 'cameraName', 'useCamera', default=None))
    scene_name = normalize_name(get_first(job_input, 'scene', 'sceneName', 'useScene', default=None))

    if end_frame < start_frame:
        raise ValueError("endFrame must be greater than or equal to startFrame")

    output_extension = OUTPUT_EXTENSIONS[output_format]
    frame_count = end_frame - start_frame + 1 if is_animation else 1

    local_blend_path = '/tmp/scene.blend'
    output_dir = '/tmp/renders'
    output_prefix = os.path.join(output_dir, 'frame_####')
    gpu_script_path = '/tmp/enable_gpu.py'
    upload_file = None

    try:
        ensure_tmp_space('download')
        os.makedirs(output_dir, exist_ok=True)
        force_cpu = normalize_bool(os.environ.get('RENDER_FORCE_CPU'), False)
        allow_cpu_fallback = normalize_bool(os.environ.get('RENDER_ALLOW_CPU_FALLBACK'), False)
        gpu_device_type = os.environ.get('RENDER_GPU_DEVICE_TYPE', 'AUTO').strip().upper() or 'AUTO'
        if gpu_device_type not in {'AUTO', 'OPTIX', 'CUDA'}:
            print(f"Unsupported RENDER_GPU_DEVICE_TYPE={gpu_device_type}; using AUTO.")
            gpu_device_type = 'AUTO'

        cuda_cache_path = os.environ.get('CUDA_CACHE_PATH', '/tmp/cuda-cache')
        os.makedirs(cuda_cache_path, exist_ok=True)

        print(
            "Render settings: "
            f"job_id={job.get('id')} "
            f"engine={engine} "
            f"samples={samples} "
            f"frames={start_frame}-{end_frame} "
            f"frame_count={frame_count} "
            f"animation={is_animation} "
            f"format={output_format} "
            f"resolution_pct={resolution_pct} "
            f"denoiser={denoiser} "
            f"scene={scene_name or 'active'} "
            f"camera={camera or 'scene camera'} "
            f"gpu_device_type={gpu_device_type} "
            f"force_cpu={force_cpu} "
            f"allow_cpu_fallback={allow_cpu_fallback} "
            f"timeout_seconds={RENDER_TIMEOUT_SECONDS}"
        )

        print(f"Downloading source blend from R2 key {file_key}...")
        s3.download_file(BUCKET_NAME, file_key, local_blend_path)
        print(f"Starting headless {engine} render...")

        gpu_script = build_blender_setup_script(
            engine,
            samples,
            output_format,
            resolution_pct,
            denoiser,
            noise_threshold,
            camera,
            scene_name,
            force_cpu,
            allow_cpu_fallback,
            gpu_device_type
        )

        with open(gpu_script_path, 'w') as f:
            f.write(gpu_script)

        render_command = ['/opt/blender/blender', '-b', local_blend_path]
        if scene_name:
            render_command.extend(['-S', scene_name])
        render_command.extend([
            '-E', engine,
            '-P', gpu_script_path,
            '-o', output_prefix
        ])

        if is_animation:
            render_command.extend(['-s', str(start_frame), '-e', str(end_frame), '-a'])
        else:
            render_command.extend(['-f', str(start_frame)])

        render_env = os.environ.copy()
        render_env.setdefault('CUDA_CACHE_PATH', cuda_cache_path)
        render_env.setdefault('CUDA_MODULE_LOADING', 'LAZY')
        process = subprocess.Popen(render_command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=render_env)
        stream_blender_process(process, job, start_frame, end_frame, samples, is_animation)

        if is_animation:
            ensure_tmp_space('zipping animation output')
            print("Zipping image sequence...")
            zip_base_path = '/tmp/render_output'
            shutil.make_archive(zip_base_path, 'zip', output_dir)

            upload_file = f"{zip_base_path}.zip"
            result_key = f"finished_renders/{job['id']}.zip"
        else:
            upload_file = find_rendered_frame(output_dir, start_frame, output_extension)
            result_key = f"finished_renders/{job['id']}.{output_extension}"

        ensure_tmp_space('upload')
        print(f"Uploading render output to R2 key {result_key}...")
        s3.upload_file(upload_file, BUCKET_NAME, result_key)

        return {
            "status": "success",
            "message": "Render complete",
            "result_key": result_key
        }

    except Exception as e:
        print(f"Render failed: {str(e)}")
        raise

    finally:
        if os.path.exists(local_blend_path):
            os.remove(local_blend_path)
        if os.path.exists(output_dir):
            shutil.rmtree(output_dir)
        if upload_file and os.path.exists(upload_file):
            os.remove(upload_file)
        if os.path.exists(gpu_script_path):
            os.remove(gpu_script_path)


runpod.serverless.start({"handler": render_job})
