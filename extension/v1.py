bl_info = {
    "name": "RunPod Render Gateway",
    "author": "Ella",
    "version": (1, 3),
    "blender": (4, 0, 0),
    "location": "View3D > Sidebar > Cloud Render",
    "category": "Render",
}

import bpy
import os
import json
import urllib.request
import http.client
from urllib.parse import urlparse

# Global variables for UI tracking
current_job_id = None
current_status = "Idle"

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
    """Runs in the background every 5 seconds to check on RunPod"""
    global current_job_id
    if not current_job_id:
        return None 

    status_endpoint = f"http://localhost:3000/api/job-status/{current_job_id}"
    
    try:
        req = urllib.request.Request(status_endpoint)
        with urllib.request.urlopen(req) as response:
            data = json.loads(response.read().decode())
            status = data.get("status")

            if status in ["IN_QUEUE", "IN_PROGRESS"]:
                set_status(f"GPU Working... ({status})")
                return 5.0  
                
            elif status == "COMPLETED":
                set_status("Downloading Render...")
                download_url = data.get("downloadUrl")

                # Download the image
                save_path = os.path.join(bpy.app.tempdir, "cloud_render_final.png")
                urllib.request.urlretrieve(download_url, save_path)

                # Load into Blender
                img = bpy.data.images.load(save_path)
                
                # Show in any open Image Editor
                for window in bpy.context.window_manager.windows:
                    for area in window.screen.areas:
                        if area.type == 'IMAGE_EDITOR':
                            area.spaces.active.image = img
                
                set_status("Render Complete! 🎉")
                current_job_id = None
                return None 
                
            else:
                set_status(f"Error: {status}")
                current_job_id = None
                return None
                
    except Exception as e:
        set_status("Network blip... retrying")
        return 5.0 

class RENDER_OT_cloud_upload(bpy.types.Operator):
    bl_idname = "render.cloud_upload"
    bl_label = "Upload & Render on RunPod"
    bl_options = {'REGISTER', 'UNDO'}

    def execute(self, context):
        global current_job_id
        
        set_status("Packing .blend file...")
        bpy.ops.file.pack_all()
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
                    
                    set_status("Job Queued. Waiting...")
                    bpy.app.timers.register(check_job_status, first_interval=3.0)
                    
            else:
                set_status("R2 Upload Failed.")
                return {'CANCELLED'}
        except Exception as e:
            set_status("Upload Error.")
            return {'CANCELLED'}

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
        
        # Disable the button if a job is currently running to prevent spamming
        row = layout.row()
        row.enabled = (current_status in ["Idle", "Render Complete! 🎉", "Error"])
        row.operator("render.cloud_upload", icon='WORLD')
        
        # Display the live status box below the button
        if current_status != "Idle":
            layout.separator()
            box = layout.box()
            icon = 'CHECKMARK' if current_status == "Render Complete! 🎉" else 'TIME'
            box.label(text=current_status, icon=icon)

def register():
    bpy.utils.register_class(RENDER_OT_cloud_upload)
    bpy.utils.register_class(RENDER_PT_cloud_panel)

def unregister():
    bpy.utils.unregister_class(RENDER_OT_cloud_upload)
    bpy.utils.unregister_class(RENDER_PT_cloud_panel)

if __name__ == "__main__":
    register()