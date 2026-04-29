import runpod
import boto3
import subprocess
import os
import shutil
import re
import time
import glob

s3 = boto3.client('s3',
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
    return value if value in valid_values else default


def build_blender_setup_script(engine, samples, output_format, resolution_pct, denoiser, noise_threshold):
    return f"""
import bpy

engine = {engine!r}
samples = {samples}
output_format = {output_format!r}
resolution_pct = {resolution_pct}
denoiser = {denoiser!r}
noise_threshold = {noise_threshold}

scene = bpy.context.scene
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
    scene.cycles.adaptive_threshold = noise_threshold

    scene.cycles.device = 'GPU'
    prefs = bpy.context.preferences
    cprefs = prefs.addons['cycles'].preferences

    def enable_devices(device_type):
        try:
            cprefs.compute_device_type = device_type
        except Exception as exc:
            print(f"Could not select {{device_type}} devices: {{exc}}")
            return False

        cprefs.get_devices()
        found = False
        for device in cprefs.devices:
            should_use = device.type == device_type
            device.use = should_use
            found = found or should_use
        return found

    if not enable_devices('OPTIX'):
        print('No OPTIX devices found; trying CUDA.')
        if not enable_devices('CUDA'):
            print('No CUDA devices found; Cycles will render with CPU.')
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


def render_job(job):
    job_input = job['input']

    file_key = job_input.get('fileKey') or job_input.get('file_key')
    engine = job_input.get('engine', 'CYCLES')
    samples = clamp_int(job_input.get('samples', 256), 1, 8192, 256)

    is_animation = job_input.get('isAnimation', False)
    start_frame = clamp_int(job_input.get('startFrame', 1), 0, 1000000, 1)
    end_frame = clamp_int(job_input.get('endFrame', 250), 0, 1000000, 250)

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
    output_extension = OUTPUT_EXTENSIONS[output_format]

    local_blend_path = '/tmp/scene.blend'
    output_dir = '/tmp/renders'
    output_prefix = os.path.join(output_dir, 'frame_####')
    gpu_script_path = '/tmp/enable_gpu.py'
    upload_file = None

    try:
        os.makedirs(output_dir, exist_ok=True)

        print(f"Downloading {file_key} from R2...")
        s3.download_file(BUCKET_NAME, file_key, local_blend_path)
        print(f"Starting headless {engine} render...")

        gpu_script = build_blender_setup_script(
            engine,
            samples,
            output_format,
            resolution_pct,
            denoiser,
            noise_threshold
        )

        with open(gpu_script_path, 'w') as f:
            f.write(gpu_script)

        render_command = [
            '/opt/blender/blender', '-b', local_blend_path,
            '-E', engine,
            '-P', gpu_script_path,
            '-o', output_prefix
        ]

        if is_animation:
            render_command.extend(['-s', str(start_frame), '-e', str(end_frame), '-a'])
        else:
            render_command.extend(['-f', str(start_frame)])

        process = subprocess.Popen(render_command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)

        last_update_time = 0
        current_frame_val = start_frame
        current_sample_val = 0

        for line in process.stdout:
            print(line, end='')

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
                    "current_sample": current_sample_val
                })
                last_update_time = now

        process.wait()

        if process.returncode != 0:
            raise RuntimeError(f"Blender crashed with exit code {process.returncode}")

        if is_animation:
            print("Zipping image sequence...")
            zip_base_path = '/tmp/render_output'
            shutil.make_archive(zip_base_path, 'zip', output_dir)

            upload_file = f"{zip_base_path}.zip"
            result_key = f"finished_renders/{job['id']}.zip"
        else:
            upload_file = find_rendered_frame(output_dir, start_frame, output_extension)
            result_key = f"finished_renders/{job['id']}.{output_extension}"

        print(f"Uploading {result_key} back to R2...")
        s3.upload_file(upload_file, BUCKET_NAME, result_key)

        return {
            "status": "success",
            "message": "Render complete",
            "result_key": result_key
        }

    except Exception as e:
        print(f"Render failed: {str(e)}")
        return {"status": "error", "message": str(e)}

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
