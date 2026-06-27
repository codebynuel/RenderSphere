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


def build_blender_setup_script(render_settings):
    return f"""
import bpy

engine = {render_settings['engine']!r}
samples = {render_settings['samples']}
output_format = {render_settings['output_format']!r}
resolution_pct = {render_settings['resolution_pct']}
denoiser = {render_settings['denoiser']!r}
noise_threshold = {render_settings['noise_threshold']}
camera_name = {render_settings['camera']!r}
scene_name = {render_settings['scene_name']!r}
force_cpu = {render_settings['force_cpu']!r}
allow_cpu_fallback = {render_settings['allow_cpu_fallback']!r}
requested_gpu_device_type = {render_settings['gpu_device_type']!r}
advanced_mode = {render_settings['advanced_mode']!r}
transparent_film = {render_settings['transparent_film']!r}
use_persistent_data = {render_settings['use_persistent_data']!r}
view_transform = {render_settings['view_transform']!r}
look = {render_settings['look']!r}
exposure = {render_settings['exposure']}
gamma = {render_settings['gamma']}
max_bounces = {render_settings['max_bounces']}
diffuse_bounces = {render_settings['diffuse_bounces']}
glossy_bounces = {render_settings['glossy_bounces']}
transmission_bounces = {render_settings['transmission_bounces']}
transparent_bounces = {render_settings['transparent_bounces']}
caustics_reflective = {render_settings['caustics_reflective']!r}
caustics_refractive = {render_settings['caustics_refractive']!r}
use_simplify = {render_settings['use_simplify']!r}
simplify_subdivisions = {render_settings['simplify_subdivisions']}
simplify_texture_limit = {render_settings['simplify_texture_limit']!r}

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

if advanced_mode:
    scene.render.film_transparent = transparent_film

    if view_transform:
        try:
            scene.view_settings.view_transform = view_transform
        except Exception as exc:
            print(f"Could not set view transform {{view_transform}}: {{exc}}")
    if look:
        try:
            scene.view_settings.look = look
        except Exception as exc:
            print(f"Could not set look {{look}}: {{exc}}")
    scene.view_settings.exposure = exposure
    scene.view_settings.gamma = gamma

    try:
        scene.render.use_persistent_data = use_persistent_data
    except Exception as exc:
        print(f"Could not set persistent data: {{exc}}")

    scene.render.use_simplify = use_simplify
    if use_simplify:
        scene.render.simplify_subdivision_render = simplify_subdivisions
        if simplify_texture_limit != 'OFF':
            try:
                scene.render.simplify_child_particles_render = simplify_subdivisions
                scene.render.simplify_texture_limit_render = simplify_texture_limit
            except Exception as exc:
                print(f"Could not set texture simplify limit {{simplify_texture_limit}}: {{exc}}")

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
    if advanced_mode:
        if hasattr(scene.cycles, 'max_bounces'):
            scene.cycles.max_bounces = max_bounces
        if hasattr(scene.cycles, 'diffuse_bounces'):
            scene.cycles.diffuse_bounces = diffuse_bounces
        if hasattr(scene.cycles, 'glossy_bounces'):
            scene.cycles.glossy_bounces = glossy_bounces
        if hasattr(scene.cycles, 'transmission_bounces'):
            scene.cycles.transmission_bounces = transmission_bounces
        if hasattr(scene.cycles, 'transparent_max_bounces'):
            scene.cycles.transparent_max_bounces = transparent_bounces
        if hasattr(scene.cycles, 'caustics_reflective'):
            scene.cycles.caustics_reflective = caustics_reflective
        if hasattr(scene.cycles, 'caustics_refractive'):
            scene.cycles.caustics_refractive = caustics_refractive

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


def stream_blender_process(process, job, start_frame, end_frame, frame_step, samples, is_animation):
    deadline = time.time() + RENDER_TIMEOUT_SECONDS
    last_update_time = 0
    current_frame_val = start_frame
    current_sample_val = 0
    frame_count = max(1, ((end_frame - start_frame) // max(frame_step, 1)) + 1 if is_animation else 1)
    recent_output = []

    def progress_percent():
        sample_ratio = min(1.0, max(0.0, current_sample_val / max(1, samples)))
        if is_animation:
            frame_index = min(frame_count - 1, max(0, (current_frame_val - start_frame) // max(frame_step, 1)))
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
                    try:
                        runpod.serverless.progress_update(job, {
                            "current_frame": current_frame_val,
                            "current_sample": current_sample_val,
                            "percent": progress_percent(),
                        })
                    except Exception:
                        pass
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

    completed_frame = start_frame
    if is_animation:
        completed_frame = start_frame + ((end_frame - start_frame) // max(frame_step, 1)) * max(frame_step, 1)

    try:
        runpod.serverless.progress_update(job, {
            "current_frame": completed_frame,
            "current_sample": samples,
            "percent": 100,
        })
    except Exception:
        pass


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
    advanced_mode = normalize_bool(get_first(job_input, 'advancedMode', 'advanced_mode', default=False), False)
    frame_step = clamp_int(get_first(job_input, 'frameStep', 'frame_step', default=1), 1, 1000, 1) if is_animation and advanced_mode else 1

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
    frame_count = ((end_frame - start_frame) // frame_step) + 1 if is_animation else 1

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

        if advanced_mode:
            gpu_device_type = normalize_choice(
                get_first(job_input, 'gpuDeviceType', 'gpu_device_type', default=gpu_device_type),
                {'AUTO', 'OPTIX', 'CUDA'},
                gpu_device_type
            )
            allow_cpu_fallback = normalize_bool(
                get_first(job_input, 'allowCpuFallback', 'allow_cpu_fallback', default=allow_cpu_fallback),
                allow_cpu_fallback
            )

        render_settings = {
            "engine": engine,
            "samples": samples,
            "output_format": output_format,
            "resolution_pct": resolution_pct,
            "denoiser": denoiser,
            "noise_threshold": noise_threshold,
            "camera": camera,
            "scene_name": scene_name,
            "force_cpu": force_cpu,
            "allow_cpu_fallback": allow_cpu_fallback,
            "gpu_device_type": gpu_device_type,
            "advanced_mode": advanced_mode,
            "transparent_film": normalize_bool(get_first(job_input, 'transparentFilm', 'transparent_film', default=False), False) if advanced_mode else False,
            "use_persistent_data": normalize_bool(get_first(job_input, 'usePersistentData', 'use_persistent_data', default=True), True) if advanced_mode else True,
            "view_transform": normalize_name(get_first(job_input, 'viewTransform', 'view_transform', default=None)) if advanced_mode else None,
            "look": normalize_name(get_first(job_input, 'look', default=None)) if advanced_mode else None,
            "exposure": clamp_float(get_first(job_input, 'exposure', default=0.0), -10.0, 10.0, 0.0) if advanced_mode else 0.0,
            "gamma": clamp_float(get_first(job_input, 'gamma', default=1.0), 0.01, 5.0, 1.0) if advanced_mode else 1.0,
            "max_bounces": clamp_int(get_first(job_input, 'maxBounces', 'max_bounces', default=12), 0, 128, 12) if advanced_mode else 12,
            "diffuse_bounces": clamp_int(get_first(job_input, 'diffuseBounces', 'diffuse_bounces', default=4), 0, 128, 4) if advanced_mode else 4,
            "glossy_bounces": clamp_int(get_first(job_input, 'glossyBounces', 'glossy_bounces', default=4), 0, 128, 4) if advanced_mode else 4,
            "transmission_bounces": clamp_int(get_first(job_input, 'transmissionBounces', 'transmission_bounces', default=12), 0, 128, 12) if advanced_mode else 12,
            "transparent_bounces": clamp_int(get_first(job_input, 'transparentBounces', 'transparent_bounces', default=8), 0, 128, 8) if advanced_mode else 8,
            "caustics_reflective": normalize_bool(get_first(job_input, 'causticsReflective', 'caustics_reflective', default=True), True) if advanced_mode else True,
            "caustics_refractive": normalize_bool(get_first(job_input, 'causticsRefractive', 'caustics_refractive', default=True), True) if advanced_mode else True,
            "use_simplify": normalize_bool(get_first(job_input, 'useSimplify', 'use_simplify', default=False), False) if advanced_mode else False,
            "simplify_subdivisions": clamp_int(get_first(job_input, 'simplifySubdivisions', 'simplify_subdivisions', default=2), 0, 12, 2) if advanced_mode else 2,
            "simplify_texture_limit": normalize_choice(
                get_first(job_input, 'simplifyTextureLimit', 'simplify_texture_limit', default='OFF'),
                {'OFF', '128', '256', '512', '1024', '2048', '4096'},
                'OFF'
            ) if advanced_mode else 'OFF',
        }

        cuda_cache_path = os.environ.get('CUDA_CACHE_PATH', '/tmp/cuda-cache')
        os.makedirs(cuda_cache_path, exist_ok=True)

        print(
            "Render settings: "
            f"job_id={job.get('id')} "
            f"engine={engine} "
            f"samples={samples} "
            f"frames={start_frame}-{end_frame} "
            f"frame_step={frame_step} "
            f"frame_count={frame_count} "
            f"animation={is_animation} "
            f"format={output_format} "
            f"resolution_pct={resolution_pct} "
            f"denoiser={denoiser} "
            f"scene={scene_name or 'active'} "
            f"camera={camera or 'scene camera'} "
            f"advanced_mode={advanced_mode} "
            f"gpu_device_type={gpu_device_type} "
            f"force_cpu={force_cpu} "
            f"allow_cpu_fallback={allow_cpu_fallback} "
            f"timeout_seconds={RENDER_TIMEOUT_SECONDS}"
        )

        print(f"Downloading source blend from R2 key {file_key}...")
        s3.download_file(BUCKET_NAME, file_key, local_blend_path)
        print(f"Starting headless {engine} render...")

        gpu_script = build_blender_setup_script(render_settings)

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
            render_command.extend(['-s', str(start_frame), '-e', str(end_frame), '-j', str(frame_step), '-a'])
        else:
            render_command.extend(['-f', str(start_frame)])

        render_env = os.environ.copy()
        render_env.setdefault('CUDA_CACHE_PATH', cuda_cache_path)
        render_env.setdefault('CUDA_MODULE_LOADING', 'LAZY')
        process = subprocess.Popen(render_command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=render_env)
        stream_blender_process(process, job, start_frame, end_frame, frame_step, samples, is_animation)

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


if __name__ == '__main__' and '--input' in __import__('sys').argv:
    # CLI mode: python3 /handler.py --input '{"fileKey":"..."}'
    import sys
    import json
    idx = sys.argv.index('--input')
    if idx + 1 < len(sys.argv):
        try:
            job_input = json.loads(sys.argv[idx + 1])
            render_job({'input': job_input, 'id': job_input.get('dispatchReference', 'cli-run')})
            print(json.dumps({'status': 'COMPLETED', 'result_key': None}))
        except Exception as exc:
            print(json.dumps({'status': 'FAILED', 'error': str(exc)}))
            sys.exit(1)
    else:
        print(json.dumps({'status': 'FAILED', 'error': '--input requires a JSON argument'}))
        sys.exit(1)
elif __name__ != '__main__':
    # Imported as module — used by runpod.serverless.start
    pass
else:
    runpod.serverless.start({"handler": render_job})
