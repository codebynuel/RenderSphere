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
    
    # Grab the variables passed from the Blender UI via Node!
    file_key = job_input.get('fileKey') or job_input.get('file_key') 
    engine = job_input.get('engine', 'CYCLES')
    samples = job_input.get('samples', 0)
    
    local_blend_path = '/tmp/scene.blend'
    output_prefix = '/tmp/render_'
    
    try:
        print(f"Downloading {file_key} from R2...")
        s3.download_file(BUCKET_NAME, file_key, local_blend_path)
        
        print(f"Starting headless {engine} render...")
        
        # Build the base Blender terminal command
        render_command = [
            '/opt/blender/blender', '-b', local_blend_path, 
            '-E', engine
        ]
        
        # If the user typed a number > 0, inject a tiny Python script to overwrite sample settings
        if samples > 0:
            expr = f"import bpy; bpy.context.scene.cycles.samples={samples}; bpy.context.scene.eevee.taa_render_samples={samples}"
            render_command.extend(['--python-expr', expr])
            
        # Cap it off with the output path and the frame number
        render_command.extend(['-o', f'{output_prefix}#', '-f', '1'])
        
        # This will block until the render is completely finished
        subprocess.run(render_command, check=True)
        
        # Blender pads the frame number, so frame 1 becomes render_1.png
        final_image_path = '/tmp/render_1.png'
        result_key = f"finished_renders/{job['id']}.png"
        
        print("Uploading finished render back to R2...")
        s3.upload_file(final_image_path, BUCKET_NAME, result_key)
        
        # Clean up the container's temp storage for the next job
        os.remove(local_blend_path)
        os.remove(final_image_path)
        
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