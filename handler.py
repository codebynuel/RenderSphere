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
    file_key = job_input['file_key'] # The key we just passed from Blender -> Node -> RunPod
    
    local_blend_path = '/tmp/scene.blend'
    output_prefix = '/tmp/render_'
    
    try:
        print(f"Downloading {file_key} from R2...")
        s3.download_file(BUCKET_NAME, file_key, local_blend_path)
        
        print("Starting headless Cycles render...")
        # Run Blender in the background (-b), force Cycles (-E CYCLES), set output path (-o), render frame 1 (-f 1)
        render_command = [
            'blender', '-b', local_blend_path, 
            '-E', 'CYCLES', 
            '-o', f'{output_prefix}#', 
            '-f', '1'
        ]
        
        # This will block until the render is completely finished
        subprocess.run(render_command, check=True)
        
        # Blender pads the frame number, so frame 1 becomes render_1.png (or 0001.png depending on settings)
        # We'll assume the standard 4-digit padding: render_0001.png
        final_image_path = '/tmp/render_0001.png'
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