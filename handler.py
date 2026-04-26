import runpod
import boto3
import subprocess
import os

# Initialize our R2 Client inside the worker
s3 = boto3.client('s3',
    endpoint_url=os.environ.get('R2_ENDPOINT'), # e.g., https://<ACCOUNT_ID>.r2.cloudflarestorage.com
    aws_access_key_id=os.environ.get('R2_ACCESS_KEY_ID'),
    aws_secret_access_key=os.environ.get('R2_SECRET_ACCESS_KEY'),
    region_name='auto'
)

BUCKET_NAME = os.environ.get('R2_BUCKET_NAME')

def render_job(job):
    job_input = job['input']
    
    file_key = job_input.get('fileKey') or job_input.get('file_key') 
    engine = job_input.get('engine', 'CYCLES')
    samples = job_input.get('samples', 0)
    
    local_blend_path = '/tmp/scene.blend'
    output_prefix = '/tmp/render_'
    gpu_script_path = '/tmp/enable_gpu.py'
    
    try:
        print(f"Downloading {file_key} from R2...")
        s3.download_file(BUCKET_NAME, file_key, local_blend_path)
        
        print(f"Starting headless {engine} render...")
        
        # We write a custom Python script to aggressively force Blender to use the RTX 4090
        gpu_script = """
import bpy

# Tell Cycles to use the GPU instead of CPU
bpy.context.scene.cycles.device = 'GPU'

# Dig into the preferences and force Nvidia OptiX
prefs = bpy.context.preferences
prefs.addons['cycles'].preferences.get_devices()
cprefs = prefs.addons['cycles'].preferences
cprefs.compute_device_type = 'OPTIX'

# Enable every OptiX device it finds (our RTX 4090)
for device in cprefs.devices:
    if device.type == 'OPTIX':
        device.use = True
"""
        # If the user passed sample overrides, append them to the script
        if samples > 0:
            gpu_script += f"\nbpy.context.scene.cycles.samples={samples}\nbpy.context.scene.eevee.taa_render_samples={samples}"

        # Save this script so Blender can run it before rendering
        with open(gpu_script_path, 'w') as f:
            f.write(gpu_script)

        # Build the base Blender terminal command and pass our new GPU script with -P
        render_command = [
            '/opt/blender/blender', '-b', local_blend_path, 
            '-E', engine,
            '-P', gpu_script_path,
            '-o', f'{output_prefix}#', 
            '-f', '1'
        ]
        
        # This will block until the render is completely finished
        subprocess.run(render_command, check=True)
        
        # Blender pads the frame number
        final_image_path = '/tmp/render_1.png'
        result_key = f"finished_renders/{job['id']}.png"
        
        print("Uploading finished render back to R2...")
        s3.upload_file(final_image_path, BUCKET_NAME, result_key)
        
        # Clean up the container's temp storage
        os.remove(local_blend_path)
        os.remove(final_image_path)
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

# Start the serverless listener
runpod.serverless.start({"handler": render_job})