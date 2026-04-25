bl_info = {
    "name": "RunPod Render Gateway",
    "author": "Ella",
    "version": (1, 5),
    "blender": (4, 0, 0),
    "location": "View3D > Sidebar > Cloud Render",
    "category": "Render",
}

import bpy
import os
import json
import urllib.request
import http.client
import time
from urllib.parse import urlparse

# Global variables for UI tracking
current_job_id = None
current_status = "Idle"
job_start_time = 0.0
last_api_check = 0.0
current_elapsed_str = ""

def force_ui_redraw():
    """Forces Blender's UI to refresh so our status text updates live"""
    for window in bpy.context.window_manager.windows:
        for area in window.screen.areas:
            if area.type == 'VIEW_3D':
                area.tag_redraw()

def set_status(text):
    """Updates the global status and refreshes the UI"""
    global current_status
    current_status = text
    force_ui_redraw()
    print(f"Status: {text}")

def check_job_status():
    """Ticks every 1 second for the clock, but only polls the API every 5 seconds"""
    global current_job_id, current_status, job_start_time, last_api_check, current_elapsed_str
    
    if not current_job_id:
        current_elapsed_str = ""
        force_ui_redraw()
        return None 

    # 1. Update the local UI clock every single second
    elapsed = int(time.time() - job_start_time)
    mins, secs = divmod(elapsed, 60)
    current_elapsed_str = f" [{mins:02d}:{secs:02d}]"
    force_ui_redraw()

    # 2. Only hit the Node API every 5 seconds to prevent spamming
    if time.time() - last_api_check >= 5.0:
        last_api_check = time.time()
        status_endpoint = f"http://localhost:3000/api/job-status/{current_job_id}"
        
        try:
            req = urllib.request.Request(status_endpoint)
            with urllib.request.urlopen(req) as response:
                data = json.loads(response.read().decode())
                status = data.get("status")

                if status in ["IN_QUEUE", "IN_PROGRESS"]:
                    current_status = f"GPU Working... ({status})"
                    
                elif status == "COMPLETED":
                    current_status = "Downloading Render..."
                    force_ui_redraw()
                    
                    download_url = data.get("downloadUrl")
                    save_path = os.path.join(bpy.app.tempdir, "cloud_render_final.png")
                    urllib.request.urlretrieve(download_url, save_path)

                    img = bpy.data.images.load(save_path)
                    
                    for window in bpy.context.window_manager.windows:
                        for area in window.screen.areas:
                            if area.type == 'IMAGE_EDITOR':
                                area.spaces.active.image = img
                    
                    current_status = "Render Complete! 🎉"
                    current_elapsed_str = f" (Took {mins:02d}:{secs:02d})"
                    current_job_id = None
                    force_ui_redraw()
                    return None 
                    
                else:
                    current_status = f"Error: {status}"
                    current_job_id = None
                    force_ui_redraw()
                    return None
                    
        except Exception as e:
            current_status = "Network blip... retrying"
            
    # Return 1.0 to keep Blender's timer ticking every second
    return 1.0 

class RENDER_OT_cloud_upload(bpy.types.Operator):
    bl_idname = "render.cloud_upload"
    bl_label = "Upload & Render on RunPod"
    bl_options = {'REGISTER', 'UNDO'}

    ignore_missing: bpy.props.BoolProperty(default=False, options={'HIDDEN'})

    def invoke(self, context, event):
        missing_files = []
        for img in bpy.data.images:
            if img.source in {'FILE', 'SEQUENCE', 'MOVIE'} and img.filepath:
                abs_path = bpy.path.abspath(img.filepath)
                if not os.path.exists(abs_path):
                    missing_files.append(img.name)
        
        if missing_files and not self.ignore_missing:
            return context.window_manager.invoke_props_dialog(self, width=400)
            
        return self.execute(context)

    def draw(self, context):
        layout = self.layout
        layout.label(text="⚠️ Warning: Missing External Files!", icon='ERROR')
        layout.label(text="This downloaded scene references files that don't exist on your PC.")
        layout.label(text="Your final render might have bright pink missing textures.")
        layout.separator()
        layout.prop(self, "ignore_missing", text="I know, proceed anyway")

    def execute(self, context):
        global current_job_id, job_start_time, last_api_check
        
        set_status("Packing .blend file...")
        try:
            bpy.ops.file.pack_all()
        except RuntimeError as e:
            print(f"Skipped packing some files: {e}")

        temp_path = os.path.join(bpy.app.tempdir, "runpod_payload.blend")
        bpy.ops.wm.save_as_mainfile(filepath=temp_path, copy=True)
        
        set_status("Securing Cloudflare link...")
        api_endpoint = "http://localhost:3000/api/get-upload-url"
        payload = json.dumps({"fileName": "runpod_payload.blend"}).encode('utf-8')
        
        try:
            req = urllib.request.Request(api_endpoint, data=payload, headers={'Content-Type': 'application/json'})
            with urllib.request.urlopen(req) as response:
                res_data = json.loads(response.read().decode())
                upload_url = res_data.get("uploadUrl")
                file_key = res_data.get("key")
        except Exception as e:
            set_status("Failed to reach Node Gateway.")
            return {'CANCELLED'}

        set_status("Uploading to Cloudflare R2...")
        try:
            parsed_url = urlparse(upload_url)
            conn = http.client.HTTPSConnection(parsed_url.netloc)
            file_size = os.path.getsize(temp_path)
            
            with open(temp_path, 'rb') as file_data:
                conn.request("PUT", parsed_url.path + "?" + parsed_url.query, body=file_data, headers={'Content-Type': 'application/octet-stream', 'Content-Length': str(file_size)})
                upload_res = conn.getresponse()
                
            if upload_res.status in [200, 201]:
                set_status("Waking up GPU Worker...")
                
                trigger_endpoint = "http://localhost:3000/api/trigger-render"
                trigger_payload = json.dumps({"fileKey": file_key}).encode('utf-8')
                trigger_req = urllib.request.Request(trigger_endpoint, data=trigger_payload, headers={'Content-Type': 'application/json'})
                
                with urllib.request.urlopen(trigger_req) as trigger_response:
                    job_data = json.loads(trigger_response.read().decode())
                    current_job_id = job_data.get("jobId")
                    
                    # Start the clock!
                    job_start_time = time.time()
                    last_api_check = time.time() - 5.0 # Force an immediate API check
                    
                    set_status("Job Queued. Waiting...")
                    bpy.app.timers.register(check_job_status, first_interval=1.0)
                    
            else:
                set_status("R2 Upload Failed.")
                return {'CANCELLED'}
        except Exception as e:
            set_status("Upload Error.")
            return {'CANCELLED'}

        self.ignore_missing = False
        return {'FINISHED'}

class RENDER_PT_cloud_panel(bpy.types.Panel):
    bl_label = "Cloud Render Gateway"
    bl_idname = "RENDER_PT_cloud_panel"
    bl_space_type = 'VIEW_3D'
    bl_region_type = 'UI'
    bl_category = 'Cloud Render'

    def draw(self, context):
        layout = self.layout
        layout.label(text="RunPod Infrastructure")
        
        row = layout.row()
        row.enabled = (current_status in ["Idle", "Render Complete! 🎉", "Error"])
        row.operator("render.cloud_upload", icon='WORLD')
        
        if current_status != "Idle":
            layout.separator()
            box = layout.box()
            icon = 'CHECKMARK' if current_status == "Render Complete! 🎉" else 'TIME'
            
            # Combine the status text and the timer string!
            box.label(text=f"{current_status}{current_elapsed_str}", icon=icon)

def register():
    bpy.utils.register_class(RENDER_OT_cloud_upload)
    bpy.utils.register_class(RENDER_PT_cloud_panel)

def unregister():
    bpy.utils.unregister_class(RENDER_OT_cloud_upload)
    bpy.utils.unregister_class(RENDER_PT_cloud_panel)

if __name__ == "__main__":
    register()