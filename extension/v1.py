bl_info = {
    "name": "RunPod Render Gateway",
    "author": "Ella",
    "version": (1, 9, 1),
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

current_job_id = None
current_status = "Idle"
current_error_msg = ""
job_start_time = 0.0
last_api_check = 0.0
current_elapsed_str = "00:00"
is_current_job_animation = False

ui_frame_current = 0
ui_sample_current = 0

def force_ui_redraw():
    for window in bpy.context.window_manager.windows:
        for area in window.screen.areas:
            if area.type == 'VIEW_3D':
                area.tag_redraw()

def set_status(text):
    global current_status
    current_status = text
    force_ui_redraw()
    print(f"Status: {text}")

def check_job_status():
    global current_job_id, current_status, current_error_msg, job_start_time, last_api_check, current_elapsed_str
    global is_current_job_animation, ui_frame_current, ui_sample_current
    
    if not current_job_id:
        return None 

    elapsed = int(time.time() - job_start_time)
    mins, secs = divmod(elapsed, 60)
    current_elapsed_str = f"{mins:02d}:{secs:02d}"
    force_ui_redraw()

    if time.time() - last_api_check >= 5.0:
        last_api_check = time.time()
        status_endpoint = f"http://localhost:3000/api/job-status/{current_job_id}"
        
        try:
            req = urllib.request.Request(status_endpoint)
            with urllib.request.urlopen(req) as response:
                data = json.loads(response.read().decode())
                status = data.get("status")

                if status in ["IN_QUEUE", "IN_PROGRESS"]:
                    
                    if status == "IN_QUEUE":
                        current_status = "In Queue..."
                    else:
                        current_status = "Rendering Animation..." if is_current_job_animation else "Rendering Frame..."

                    stream_data = data.get("stream", [])
                    if stream_data and isinstance(stream_data, list):
                        for item in reversed(stream_data):
                            payload = item
                            
                            if isinstance(item, dict):
                                if "update" in item: payload = item["update"]
                                elif "output" in item: payload = item["output"]
                                
                            if isinstance(payload, str):
                                try:
                                    payload = json.loads(payload)
                                except:
                                    pass
                                    
                            if isinstance(payload, dict):
                                found_data = False
                                if "current_frame" in payload:
                                    ui_frame_current = payload["current_frame"]
                                    found_data = True
                                if "current_sample" in payload:
                                    ui_sample_current = payload["current_sample"]
                                    found_data = True
                                
                                if found_data:
                                    break 
                    
                elif status == "COMPLETED":
                    set_status("Downloading Render...")
                    download_url = data.get("downloadUrl")

                    if is_current_job_animation:
                        desktop_path = os.path.join(os.path.expanduser("~"), "Desktop", f"animation_{current_job_id[:6]}.zip")
                        urllib.request.urlretrieve(download_url, desktop_path)
                        current_status = "Zip saved to Desktop! 🎉"
                    else:
                        save_path = os.path.join(bpy.app.tempdir, "cloud_render_final.png")
                        urllib.request.urlretrieve(download_url, save_path)
                        img = bpy.data.images.load(save_path)
                        
                        for window in bpy.context.window_manager.windows:
                            for area in window.screen.areas:
                                if area.type == 'IMAGE_EDITOR':
                                    area.spaces.active.image = img
                        current_status = "Render Complete! 🎉"

                    current_job_id = None
                    force_ui_redraw()
                    return None 
                
                # FIXED: Added explicit failure handling
                elif status == "FAILED":
                    current_status = "Render Failed ❌"
                    current_error_msg = str(data.get("error", "Unknown RunPod error."))
                    current_job_id = None
                    force_ui_redraw()
                    return None
                    
                else:
                    current_status = f"Error: {status}"
                    current_job_id = None
                    force_ui_redraw()
                    return None
                    
        except Exception as e:
            pass 
            
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
        global current_job_id, job_start_time, last_api_check, current_error_msg
        global is_current_job_animation, ui_frame_current, ui_sample_current
        
        ui_frame_current = context.scene.runpod_frame_start
        ui_sample_current = 0
        current_error_msg = ""
        
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
                
                is_current_job_animation = context.scene.runpod_is_animation
                
                trigger_endpoint = "http://localhost:3000/api/trigger-render"
                trigger_payload = json.dumps({
                    "fileKey": file_key,
                    "engine": context.scene.runpod_engine,
                    "samples": context.scene.runpod_samples,
                    "isAnimation": context.scene.runpod_is_animation,
                    "startFrame": context.scene.runpod_frame_start,
                    "endFrame": context.scene.runpod_frame_end
                }).encode('utf-8')
                
                trigger_req = urllib.request.Request(trigger_endpoint, data=trigger_payload, headers={'Content-Type': 'application/json'})
                
                with urllib.request.urlopen(trigger_req) as trigger_response:
                    job_data = json.loads(trigger_response.read().decode())
                    current_job_id = job_data.get("jobId")
                    
                    job_start_time = time.time()
                    last_api_check = time.time() - 5.0
                    
                    set_status("In Queue...")
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
        
        layout.label(text="Cloud Settings:", icon='PREFERENCES')
        layout.prop(context.scene, "runpod_engine")
        layout.prop(context.scene, "runpod_samples")
        
        layout.separator()
        layout.prop(context.scene, "runpod_is_animation", icon='RENDER_ANIMATION')
        
        if context.scene.runpod_is_animation:
            row = layout.row(align=True)
            row.prop(context.scene, "runpod_frame_start")
            row.prop(context.scene, "runpod_frame_end")
            
        layout.separator()
        
        # Unlocked the button if it's in a failed state so you can retry
        row = layout.row()
        row.enabled = (current_status in ["Idle", "Render Complete! 🎉", "Zip saved to Desktop! 🎉", "Render Failed ❌", "Error"])
        
        btn_text = "Render Animation on RunPod" if context.scene.runpod_is_animation else "Render Frame on RunPod"
        row.operator("render.cloud_upload", text=btn_text, icon='WORLD')
        
        if current_status != "Idle":
            layout.separator()
            box = layout.box()
            
            if current_status == "Render Failed ❌":
                box.label(text=current_status, icon='ERROR')
                box.label(text=f"Error: {current_error_msg}")
            else:
                icon = 'CHECKMARK' if "🎉" in current_status else 'TIME'
                box.label(text=f"Status: {current_status}", icon=icon)
                
                if current_status in ["In Queue...", "Rendering Animation...", "Rendering Frame..."]:
                    box.label(text=f"Elapsed time: {current_elapsed_str}")
                    
                    target_samples = context.scene.runpod_samples
                    if context.scene.runpod_is_animation:
                        total_frames = context.scene.runpod_frame_end - context.scene.runpod_frame_start + 1
                        pct = int((ui_frame_current / max(total_frames, 1)) * 100)
                    else:
                        total_frames = 1
                        pct = int((ui_sample_current / max(target_samples, 1)) * 100)
                    
                    pct = min(100, pct) 
                    
                    box.label(text=f"Frame: {ui_frame_current} / {total_frames}")
                    box.label(text=f"Samples: {ui_sample_current} / {target_samples}")
                    box.label(text=f"Percentage Done: {pct}%")
                    
                elif "🎉" in current_status:
                    box.label(text=f"Elapsed time: {current_elapsed_str}")

def register():
    bpy.types.Scene.runpod_engine = bpy.props.EnumProperty(
        name="Engine",
        items=[('CYCLES', 'Cycles', ''), ('BLENDER_EEVEE_NEXT', 'Eevee', '')],
        default='CYCLES'
    )
    bpy.types.Scene.runpod_samples = bpy.props.IntProperty(
        name="Samples",
        description="Ray-tracing samples per pixel",
        default=256, 
        min=1,
        max=8192
    )
    bpy.types.Scene.runpod_is_animation = bpy.props.BoolProperty(
        name="Render Animation",
        description="Renders a sequence of frames and returns a .zip file",
        default=False
    )
    bpy.types.Scene.runpod_frame_start = bpy.props.IntProperty(
        name="Start",
        default=1,
        min=0
    )
    bpy.types.Scene.runpod_frame_end = bpy.props.IntProperty(
        name="End",
        default=250,
        min=1
    )
    
    bpy.utils.register_class(RENDER_OT_cloud_upload)
    bpy.utils.register_class(RENDER_PT_cloud_panel)

def unregister():
    del bpy.types.Scene.runpod_engine
    del bpy.types.Scene.runpod_samples
    del bpy.types.Scene.runpod_is_animation
    del bpy.types.Scene.runpod_frame_start
    del bpy.types.Scene.runpod_frame_end
    bpy.utils.unregister_class(RENDER_OT_cloud_upload)
    bpy.utils.unregister_class(RENDER_PT_cloud_panel)

if __name__ == "__main__":
    register()