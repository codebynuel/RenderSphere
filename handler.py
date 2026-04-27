import runpod
import boto3
import subprocess
import os
import shutil
import re
import time

s3 = boto3.client('s3',
    endpoint_url=os.environ.get('R2_ENDPOINT'),
    aws_access_key_id=os.environ.get('R2_ACCESS_KEY_ID'),
    aws_secret_access_key=os.environ.get('R2_SECRET_ACCESS_KEY'),
    region_name='auto'
)

BUCKET_NAME = os.environ.get('R2_BUCKET_NAME')

def render_job(job):
    job_input = job['input']
    
    file_key = job_input.get('fileKey') or job_input.get('file_key') 
    engine = job_input.get('engine', 'CYCLES')
    samples = job_input.get('samples', 256)
    
    is_animation = job_input.get('isAnimation', False)
    start_frame = job_input.get('startFrame', 1)
    end_frame = job_input.get('endFrame', 250)
    
    local_blend_path = '/tmp/scene.blend'
    output_dir = '/tmp/renders'
    os.makedirs(output_dir, exist_ok=True)
    
    output_prefix = os.path.join(output_dir, 'frame_####')
    gpu_script_path = '/tmp/enable_gpu.py'
    
    try:
        print(f"Downloading {file_key} from R2...")
        s3.download_file(BUCKET_NAME, file_key, local_blend_path)
        print(f"Starting headless {engine} render...")
        
        gpu_script = """
import bpy
bpy.context.scene.cycles.device = 'GPU'
prefs = bpy.context.preferences
prefs.addons['cycles'].preferences.get_devices()
cprefs = prefs.addons['cycles'].preferences
cprefs.compute_device_type = 'OPTIX'
for device in cprefs.devices:
    if device.type == 'OPTIX':
        device.use = True
"""
        if samples > 0:
            gpu_script += f"\nbpy.context.scene.cycles.samples={samples}\nbpy.context.scene.eevee.taa_render_samples={samples}"

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
            
            # Use Regex to hunt for the frame and sample numbers in the log output
            frame_match = re.search(r'Fra:(\d+)', line)
            sample_match = re.search(r'Sample (\d+)/', line)
            
            changed = False
            if frame_match:
                current_frame_val = int(frame_match.group(1))
                changed = True
            if sample_match:
                current_sample_val = int(sample_match.group(1))
                changed = True
                
            # Throttle the API ping to once every 2 seconds to prevent RunPod from dropping packets!
            now = time.time()
            if changed and (now - last_update_time > 2.0):
                runpod.serverless.progress_update({
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
            frame_str = str(start_frame).zfill(4)
            upload_file = os.path.join(output_dir, f'frame_{frame_str}.png')
            result_key = f"finished_renders/{job['id']}.png"
            
        print(f"Uploading {result_key} back to R2...")
        s3.upload_file(upload_file, BUCKET_NAME, result_key)
        
        os.remove(local_blend_path)
        shutil.rmtree(output_dir) 
        if os.path.exists(upload_file):
            os.remove(upload_file)
        if os.path.exists(gpu_script_path):
            os.remove(gpu_script_path)
        
        return {
            "status": "success",
            "message": "Render complete",
            "result_key": result_key
        }

    except Exception as e:
        print(f"Render failed: {str(e)}")
        return {"status": "error", "message": str(e)}

runpod.serverless.start({"handler": render_job})