bl_info = {
    "name": "RenderSphere Extension",
    "author": "Ella",
    "version": (1, 10, 0),
    "blender": (4, 0, 0),
    "location": "View3D > Sidebar > Cloud Render",
    "category": "Render",
}

import bpy
import os
import json
import urllib.request
import urllib.error
import http.client
import time
from urllib.parse import urlparse

DEFAULT_SERVER_URL = "http://localhost:3000"
MAX_UPLOAD_BYTES = 500 * 1024 * 1024
ADDON_VERSION = ".".join(str(part) for part in bl_info["version"])

OUTPUT_EXTENSIONS = {
    "PNG": "png",
    "JPEG": "jpg",
    "OPEN_EXR": "exr",
    "OPEN_EXR_MULTILAYER": "exr",
}

current_job_id = None
current_status = "Idle"
current_error_msg = ""
job_start_time = 0.0
last_api_check = 0.0
current_elapsed_str = "00:00"
is_current_job_animation = False
current_start_frame = 1
current_end_frame = 1
current_download_extension = "png"

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


def reset_job_state(status="Idle"):
    global current_job_id, current_status, current_error_msg, job_start_time, last_api_check
    global current_elapsed_str, is_current_job_animation, ui_frame_current, ui_sample_current

    current_job_id = None
    current_status = status
    current_error_msg = ""
    job_start_time = 0.0
    last_api_check = 0.0
    current_elapsed_str = "00:00"
    is_current_job_animation = False
    ui_frame_current = 0
    ui_sample_current = 0
    force_ui_redraw()


def get_server_url(context=None):
    addon_keys = [key for key in {__package__, __name__} if key]
    context = context or bpy.context

    for addon_key in addon_keys:
        addon = context.preferences.addons.get(addon_key)
        if addon and addon.preferences.server_url:
            return addon.preferences.server_url.rstrip("/")

    return DEFAULT_SERVER_URL


def get_api_key(context=None):
    addon_keys = [key for key in {__package__, __name__} if key]
    context = context or bpy.context

    for addon_key in addon_keys:
        addon = context.preferences.addons.get(addon_key)
        if addon and addon.preferences.api_key:
            return addon.preferences.api_key.strip()

    return ""


def get_animation_output_dir(context=None):
    addon_keys = [key for key in {__package__, __name__} if key]
    context = context or bpy.context

    for addon_key in addon_keys:
        addon = context.preferences.addons.get(addon_key)
        if addon and addon.preferences.animation_output_dir:
            return bpy.path.abspath(addon.preferences.animation_output_dir)

    return os.path.join(os.path.expanduser("~"), "Desktop")


def auth_headers(context=None, content_type=None):
    headers = {}
    api_key = get_api_key(context)
    if api_key:
        headers['Authorization'] = f"Bearer {api_key}"
    if content_type:
        headers['Content-Type'] = content_type
    return headers


def describe_url_error(error):
    if isinstance(error, urllib.error.HTTPError):
        try:
            body = error.read().decode('utf-8')
            data = json.loads(body)
            message = data.get("error") or data.get("message") or body
        except Exception:
            message = error.reason
        return f"{error.code}: {message}"

    return str(error)


def remove_temp_payload(temp_path):
    try:
        if temp_path and os.path.exists(temp_path):
            os.remove(temp_path)
    except Exception as exc:
        print(f"Could not remove temp payload: {exc}")


def get_missing_external_files():
    missing_files = []
    for img in bpy.data.images:
        if img.source in {'FILE', 'SEQUENCE', 'MOVIE'} and img.filepath:
            abs_path = bpy.path.abspath(img.filepath)
            if not os.path.exists(abs_path):
                missing_files.append(img.name)
    return missing_files


def get_render_frame_range(scene):
    start_frame = scene.frame_start if scene.runpod_use_scene_frames else scene.runpod_frame_start
    end_frame = scene.frame_end if scene.runpod_use_scene_frames else scene.runpod_frame_end
    return start_frame, end_frame if scene.runpod_is_animation else start_frame


def describe_render_job(scene):
    start_frame, end_frame = get_render_frame_range(scene)
    frame_count = end_frame - start_frame + 1
    render_type = "Animation" if scene.runpod_is_animation else "Still frame"
    return {
        "render_type": render_type,
        "start_frame": start_frame,
        "end_frame": end_frame,
        "frame_count": frame_count,
        "samples": scene.runpod_samples,
        "resolution_pct": scene.runpod_resolution_pct,
        "format": scene.runpod_output_format,
    }


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
        status_endpoint = f"{get_server_url()}/api/job-status/{current_job_id}"

        try:
            req = urllib.request.Request(status_endpoint, headers=auth_headers())
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
                                if "update" in item:
                                    payload = item["update"]
                                elif "output" in item:
                                    payload = item["output"]

                            if isinstance(payload, str):
                                try:
                                    payload = json.loads(payload)
                                except Exception:
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
                        output_dir = get_animation_output_dir()
                        os.makedirs(output_dir, exist_ok=True)
                        zip_path = os.path.join(output_dir, f"animation_{current_job_id[:6]}.zip")
                        urllib.request.urlretrieve(download_url, zip_path)
                        current_status = "Zip saved."
                    else:
                        save_path = os.path.join(bpy.app.tempdir, f"cloud_render_final.{current_download_extension}")
                        urllib.request.urlretrieve(download_url, save_path)
                        img = bpy.data.images.load(save_path)

                        for window in bpy.context.window_manager.windows:
                            for area in window.screen.areas:
                                if area.type == 'IMAGE_EDITOR':
                                    area.spaces.active.image = img
                        current_status = "Render Complete."

                    current_job_id = None
                    force_ui_redraw()
                    return None

                elif status == "FAILED":
                    current_status = "Render Failed"
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
            print(f"Status check failed: {e}")

    return 1.0


class RENDERSPHERE_AddonPreferences(bpy.types.AddonPreferences):
    bl_idname = __package__ if __package__ else __name__

    server_url: bpy.props.StringProperty(
        name="Gateway URL",
        description="RenderSphere gateway server URL",
        default=DEFAULT_SERVER_URL,
    )
    api_key: bpy.props.StringProperty(
        name="API Key",
        description="RenderSphere API key from your account dashboard",
        default="",
        subtype='PASSWORD',
    )
    animation_output_dir: bpy.props.StringProperty(
        name="Animation Download Folder",
        description="Folder used for completed animation zip downloads",
        default="",
        subtype='DIR_PATH',
    )

    def draw(self, context):
        layout = self.layout
        layout.label(text=f"RenderSphere Add-on v{ADDON_VERSION}")
        layout.prop(self, "server_url")
        layout.prop(self, "api_key")
        layout.prop(self, "animation_output_dir")
        layout.operator("rendersphere.test_connection", icon='URL')


class RENDERSPHERE_OT_test_connection(bpy.types.Operator):
    bl_idname = "rendersphere.test_connection"
    bl_label = "Test RenderSphere Connection"
    bl_options = {'REGISTER'}

    def execute(self, context):
        global current_error_msg

        if not get_api_key(context):
            current_error_msg = "Add your RenderSphere API key before testing."
            self.report({'ERROR'}, current_error_msg)
            set_status("Render Failed")
            return {'CANCELLED'}

        try:
            req = urllib.request.Request(f"{get_server_url(context)}/api/auth/me", headers=auth_headers(context))
            with urllib.request.urlopen(req, timeout=15) as response:
                data = json.loads(response.read().decode())
                user = data.get("user", {})
                email = user.get("email", "account")

            current_error_msg = ""
            set_status("Connection OK")
            self.report({'INFO'}, f"Connected as {email}")
            return {'FINISHED'}
        except Exception as exc:
            current_error_msg = describe_url_error(exc)
            set_status("Render Failed")
            self.report({'ERROR'}, current_error_msg)
            return {'CANCELLED'}


class RENDER_OT_cloud_upload(bpy.types.Operator):
    bl_idname = "render.cloud_upload"
    bl_label = "Upload & Render on RunPod"
    bl_options = {'REGISTER', 'UNDO'}

    ignore_missing: bpy.props.BoolProperty(default=False, options={'HIDDEN'})
    missing_summary: bpy.props.StringProperty(default="", options={'HIDDEN'})

    def invoke(self, context, event):
        missing_files = get_missing_external_files()
        self.missing_summary = ", ".join(missing_files[:5])
        if len(missing_files) > 5:
            self.missing_summary += f" and {len(missing_files) - 5} more"

        return context.window_manager.invoke_props_dialog(self, width=460)

    def draw(self, context):
        layout = self.layout
        scene = context.scene
        summary = describe_render_job(scene)

        if self.missing_summary:
            layout.label(text="Warning: Missing External Files", icon='ERROR')
            layout.label(text=self.missing_summary)
            layout.label(text="Your final render might have missing textures.")
            layout.prop(self, "ignore_missing", text="Proceed with missing files")
            layout.separator()

        layout.label(text="Confirm Render Job", icon='RENDER_STILL')
        layout.label(text=f"Type: {summary['render_type']}")
        layout.label(text=f"Frames: {summary['start_frame']} - {summary['end_frame']} ({summary['frame_count']} total)")
        layout.label(text=f"Samples: {summary['samples']}")
        layout.label(text=f"Resolution: {summary['resolution_pct']}%")
        layout.label(text=f"Format: {summary['format']}")
        layout.separator()
        layout.label(text="This will use one render credit if the job starts.")

    def execute(self, context):
        global current_job_id, job_start_time, last_api_check, current_error_msg
        global is_current_job_animation, current_start_frame, current_end_frame, current_download_extension
        global ui_frame_current, ui_sample_current

        scene = context.scene
        server_url = get_server_url(context)
        if not get_api_key(context):
            current_error_msg = "Add your RenderSphere API key in the add-on preferences."
            set_status("Render Failed")
            return {'CANCELLED'}

        missing_files = get_missing_external_files()
        if missing_files and not self.ignore_missing:
            current_error_msg = "Missing external files must be acknowledged before rendering."
            set_status("Render Failed")
            return {'CANCELLED'}

        start_frame, end_frame = get_render_frame_range(scene)

        if end_frame < start_frame:
            current_error_msg = "End frame must be greater than or equal to start frame."
            set_status("Render Failed")
            return {'CANCELLED'}

        current_start_frame = start_frame
        current_end_frame = end_frame if scene.runpod_is_animation else start_frame
        current_download_extension = OUTPUT_EXTENSIONS.get(scene.runpod_output_format, "png")
        ui_frame_current = start_frame
        ui_sample_current = 0
        current_error_msg = ""

        set_status("Packing .blend file...")
        try:
            bpy.ops.file.pack_all()
        except RuntimeError as e:
            print(f"Skipped packing some files: {e}")

        temp_path = os.path.join(bpy.app.tempdir, "runpod_payload.blend")
        bpy.ops.wm.save_as_mainfile(filepath=temp_path, copy=True)
        file_size = os.path.getsize(temp_path)

        if file_size > MAX_UPLOAD_BYTES:
            current_error_msg = f"Packed file is larger than {MAX_UPLOAD_BYTES // (1024 * 1024)} MB."
            set_status("Render Failed")
            remove_temp_payload(temp_path)
            return {'CANCELLED'}

        set_status("Securing Cloudflare link...")
        api_endpoint = f"{server_url}/api/get-upload-url"
        payload = json.dumps({
            "fileName": "runpod_payload.blend",
            "fileSizeBytes": file_size,
        }).encode('utf-8')

        try:
            req = urllib.request.Request(api_endpoint, data=payload, headers=auth_headers(context, 'application/json'))
            with urllib.request.urlopen(req) as response:
                res_data = json.loads(response.read().decode())
                upload_url = res_data.get("uploadUrl")
                file_key = res_data.get("key")
        except Exception as e:
            print(f"Upload URL request failed: {e}")
            current_error_msg = describe_url_error(e)
            set_status("Render Failed")
            remove_temp_payload(temp_path)
            return {'CANCELLED'}

        set_status("Uploading to Cloudflare R2...")
        try:
            parsed_url = urlparse(upload_url)
            conn = http.client.HTTPSConnection(parsed_url.netloc)

            with open(temp_path, 'rb') as file_data:
                conn.request(
                    "PUT",
                    parsed_url.path + "?" + parsed_url.query,
                    body=file_data,
                    headers={'Content-Type': 'application/octet-stream', 'Content-Length': str(file_size)}
                )
                upload_res = conn.getresponse()

            if upload_res.status in [200, 201]:
                set_status("Waking up GPU Worker...")

                is_current_job_animation = scene.runpod_is_animation

                trigger_endpoint = f"{server_url}/api/trigger-render"
                trigger_payload = json.dumps({
                    "fileKey": file_key,
                    "engine": scene.runpod_engine,
                    "samples": scene.runpod_samples,
                    "isAnimation": scene.runpod_is_animation,
                    "startFrame": start_frame,
                    "endFrame": end_frame,
                    "outputFormat": scene.runpod_output_format,
                    "resolutionPct": scene.runpod_resolution_pct,
                    "denoiser": scene.runpod_denoiser,
                    "noiseThreshold": scene.runpod_noise_threshold,
                }).encode('utf-8')

                trigger_req = urllib.request.Request(trigger_endpoint, data=trigger_payload, headers=auth_headers(context, 'application/json'))

                with urllib.request.urlopen(trigger_req) as trigger_response:
                    job_data = json.loads(trigger_response.read().decode())
                    current_job_id = job_data.get("jobId")

                    job_start_time = time.time()
                    last_api_check = time.time() - 5.0

                    set_status("In Queue...")
                    bpy.app.timers.register(check_job_status, first_interval=1.0)

            else:
                current_error_msg = f"R2 upload failed with status {upload_res.status}."
                set_status("Render Failed")
                remove_temp_payload(temp_path)
                return {'CANCELLED'}
        except Exception as e:
            print(f"Upload or trigger failed: {e}")
            current_error_msg = describe_url_error(e)
            set_status("Render Failed")
            remove_temp_payload(temp_path)
            return {'CANCELLED'}

        self.ignore_missing = False
        remove_temp_payload(temp_path)
        return {'FINISHED'}


class RENDER_OT_cancel_job(bpy.types.Operator):
    bl_idname = "render.cancel_job"
    bl_label = "Cancel RunPod Job"
    bl_options = {'REGISTER'}

    def execute(self, context):
        global current_job_id

        if not current_job_id:
            reset_job_state()
            return {'CANCELLED'}

        job_id = current_job_id
        set_status("Cancelling Job...")

        try:
            payload = json.dumps({"jobId": job_id}).encode('utf-8')
            req = urllib.request.Request(
                f"{get_server_url(context)}/api/cancel-job",
                data=payload,
                headers=auth_headers(context, 'application/json'),
                method='POST',
            )
            with urllib.request.urlopen(req) as response:
                response.read()
        except Exception as e:
            print(f"Cancel request failed: {e}")
        finally:
            reset_job_state()

        return {'FINISHED'}


class RENDER_PT_cloud_panel(bpy.types.Panel):
    bl_label = "Cloud Render Gateway"
    bl_idname = "RENDER_PT_cloud_panel"
    bl_space_type = 'VIEW_3D'
    bl_region_type = 'UI'
    bl_category = 'Cloud Render'

    def draw(self, context):
        layout = self.layout
        scene = context.scene

        layout.label(text="Cloud Settings:", icon='PREFERENCES')
        layout.prop(scene, "runpod_engine")
        layout.prop(scene, "runpod_samples")

        layout.separator()
        layout.label(text="Output", icon='OUTPUT')
        layout.prop(scene, "runpod_output_format")
        layout.prop(scene, "runpod_resolution_pct")

        if scene.runpod_engine == 'CYCLES':
            layout.separator()
            layout.label(text="Quality", icon='SHADING_RENDERED')
            layout.prop(scene, "runpod_denoiser")
            layout.prop(scene, "runpod_noise_threshold")

        layout.separator()
        layout.prop(scene, "runpod_is_animation", icon='RENDER_ANIMATION')

        if scene.runpod_is_animation:
            layout.prop(scene, "runpod_use_scene_frames")
            row = layout.row(align=True)
            row.enabled = not scene.runpod_use_scene_frames
            row.prop(scene, "runpod_frame_start")
            row.prop(scene, "runpod_frame_end")

        layout.separator()

        row = layout.row()
        row.enabled = current_job_id is None and current_status in [
            "Idle",
            "Render Complete.",
            "Zip saved.",
            "Render Failed",
            "Connection OK",
            "Error",
        ]

        btn_text = "Render Animation" if scene.runpod_is_animation else "Render Frame"
        row.operator("render.cloud_upload", text=btn_text, icon='WORLD')

        if current_job_id:
            cancel_row = layout.row()
            cancel_row.operator("render.cancel_job", text="Cancel Job", icon='CANCEL')

        if current_status != "Idle":
            layout.separator()
            box = layout.box()

            if current_status == "Render Failed":
                box.label(text=current_status, icon='ERROR')
                box.label(text=f"Error: {current_error_msg}")
            else:
                icon = 'CHECKMARK' if current_status in ["Render Complete.", "Zip saved.", "Connection OK"] else 'TIME'
                box.label(text=f"Status: {current_status}", icon=icon)

                if current_status in ["In Queue...", "Rendering Animation...", "Rendering Frame..."]:
                    box.label(text=f"Elapsed time: {current_elapsed_str}")

                    target_samples = scene.runpod_samples
                    if is_current_job_animation:
                        total_frames = current_end_frame - current_start_frame + 1
                        completed_frames = ui_frame_current - current_start_frame + 1
                        pct = int((completed_frames / max(total_frames, 1)) * 100)
                    else:
                        total_frames = 1
                        pct = int((ui_sample_current / max(target_samples, 1)) * 100)

                    pct = min(100, max(0, pct))

                    box.label(text=f"Frame: {ui_frame_current} / {current_end_frame}")
                    box.label(text=f"Samples: {ui_sample_current} / {target_samples}")
                    box.label(text=f"Percentage Done: {pct}%")

                elif current_status in ["Render Complete.", "Zip saved."]:
                    box.label(text=f"Elapsed time: {current_elapsed_str}")


classes = (
    RENDERSPHERE_AddonPreferences,
    RENDERSPHERE_OT_test_connection,
    RENDER_OT_cloud_upload,
    RENDER_OT_cancel_job,
    RENDER_PT_cloud_panel,
)


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
    bpy.types.Scene.runpod_output_format = bpy.props.EnumProperty(
        name="Format",
        items=[
            ('PNG', 'PNG', ''),
            ('JPEG', 'JPEG', ''),
            ('OPEN_EXR', 'OpenEXR', ''),
            ('OPEN_EXR_MULTILAYER', 'Multilayer OpenEXR', ''),
        ],
        default='PNG'
    )
    bpy.types.Scene.runpod_resolution_pct = bpy.props.IntProperty(
        name="Resolution %",
        description="Resolution scale percentage",
        default=100,
        min=1,
        max=200
    )
    bpy.types.Scene.runpod_use_scene_frames = bpy.props.BoolProperty(
        name="Use Scene Frame Range",
        description="Read start and end from the scene frame range when submitting the job",
        default=False
    )
    bpy.types.Scene.runpod_denoiser = bpy.props.EnumProperty(
        name="Denoiser",
        items=[
            ('NONE', 'None', ''),
            ('OPTIX', 'OptiX', ''),
            ('OPENIMAGEDENOISE', 'OpenImageDenoise', ''),
        ],
        default='NONE'
    )
    bpy.types.Scene.runpod_noise_threshold = bpy.props.FloatProperty(
        name="Noise Threshold",
        description="Cycles adaptive sampling threshold. 0 disables adaptive sampling.",
        default=0.01,
        min=0.0,
        max=1.0
    )

    for cls in classes:
        bpy.utils.register_class(cls)


def unregister():
    for cls in reversed(classes):
        bpy.utils.unregister_class(cls)

    del bpy.types.Scene.runpod_engine
    del bpy.types.Scene.runpod_samples
    del bpy.types.Scene.runpod_is_animation
    del bpy.types.Scene.runpod_frame_start
    del bpy.types.Scene.runpod_frame_end
    del bpy.types.Scene.runpod_output_format
    del bpy.types.Scene.runpod_resolution_pct
    del bpy.types.Scene.runpod_use_scene_frames
    del bpy.types.Scene.runpod_denoiser
    del bpy.types.Scene.runpod_noise_threshold


if __name__ == "__main__":
    register()
