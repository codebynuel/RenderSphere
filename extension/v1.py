bl_info = {
    "name": "RenderSphere Extension",
    "author": "Ella",
    "version": (1, 14, 0),
    "blender": (4, 0, 0),
    "location": "View3D > Sidebar > RenderSphere",
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
DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024 * 1024
ADDON_VERSION = ".".join(str(part) for part in bl_info["version"])

OUTPUT_EXTENSIONS = {
    "PNG": "png",
    "JPEG": "jpg",
    "OPEN_EXR": "exr",
    "OPEN_EXR_MULTILAYER": "exr",
}
GPU_BACKEND_ITEMS = [
    ('AUTO', 'Auto', 'Use the fastest compatible GPU backend'),
    ('OPTIX', 'OptiX', 'Prefer OptiX on supported NVIDIA GPUs'),
    ('CUDA', 'CUDA', 'Prefer CUDA on supported NVIDIA GPUs'),
]

current_job_id = None
current_status = "Idle"
current_error_msg = ""
job_start_time = 0.0
last_api_check = 0.0
current_elapsed_str = "00:00"
is_current_job_animation = False
current_start_frame = 1
current_end_frame = 1
current_frame_step = 1
current_download_extension = "png"

ui_frame_current = 0
ui_sample_current = 0

LOG_PREFIX = "[RenderSphere]"
ACTIVE_RENDER_STATUSES = {"In Queue...", "Rendering Animation...", "Rendering Frame...", "Downloading Render..."}
READY_RENDER_STATUSES = {"Idle", "Render Complete.", "Zip saved.", "Render Failed", "Connection OK", "Error", "Cancelled."}
INTERNAL_RENDER_ERROR_MARKERS = (
    "runpod",
    "traceback",
    "error_traceback",
    "hostname",
    "worker_id",
    "serverless",
    "rp_job.py",
    "handler.py",
    "/usr/local/",
)
GUIDED_WALL_ITEMS = [
    ('AUTH', '1 · Connect', 'Connect your RenderSphere account'),
    ('TARGET', '2 · Target', 'Choose scene, camera, and project'),
    ('OUTPUT', '3 · Output', 'Choose output format and frame range'),
    ('QUALITY', '4 · Quality', 'Choose engine and quality settings'),
    ('REVIEW', '5 · Review', 'Confirm and submit the render'),
    ('PROGRESS', '6 · Progress', 'Track render progress and results'),
]
GUIDED_WALL_ORDER = [item[0] for item in GUIDED_WALL_ITEMS]
GUIDED_WALL_LABELS = {item[0]: item[1] for item in GUIDED_WALL_ITEMS}
GUIDED_WALL_DESCRIPTIONS = {item[0]: item[2] for item in GUIDED_WALL_ITEMS}


def force_ui_redraw():
    for window in bpy.context.window_manager.windows:
        for area in window.screen.areas:
            if area.type == 'VIEW_3D':
                area.tag_redraw()


def verbose_logging_enabled(context=None):
    prefs = get_addon_preferences(context)
    if prefs and hasattr(prefs, "verbose_logging"):
        return bool(prefs.verbose_logging)
    return True


def log_verbose(message, context=None, **details):
    if not verbose_logging_enabled(context):
        return

    timestamp = time.strftime("%H:%M:%S")
    suffix = ""
    if details:
        safe_details = []
        for key, value in details.items():
            if "key" in key.lower() or "token" in key.lower() or "authorization" in key.lower():
                value = "<redacted>"
            safe_details.append(f"{key}={value}")
        suffix = " | " + ", ".join(safe_details)
    print(f"{LOG_PREFIX} {timestamp} | {message}{suffix}")


def set_status(text):
    global current_status
    current_status = text
    force_ui_redraw()
    log_verbose("Status updated", status=text)


def reset_job_state(status="Idle"):
    global current_job_id, current_status, current_error_msg, job_start_time, last_api_check
    global current_elapsed_str, is_current_job_animation, current_frame_step, ui_frame_current, ui_sample_current

    log_verbose("Resetting job state", previous_job_id=current_job_id, next_status=status)
    current_job_id = None
    current_status = status
    current_error_msg = ""
    job_start_time = 0.0
    last_api_check = 0.0
    current_elapsed_str = "00:00"
    is_current_job_animation = False
    current_frame_step = 1
    ui_frame_current = 0
    ui_sample_current = 0
    force_ui_redraw()


def get_addon_preferences(context=None):
    addon_keys = [key for key in {__package__, __name__} if key]
    context = context or bpy.context

    for addon_key in addon_keys:
        addon = context.preferences.addons.get(addon_key)
        if addon:
            return addon.preferences

    return None


def get_server_url(context=None):
    prefs = get_addon_preferences(context)
    if prefs and prefs.server_url:
        return prefs.server_url.rstrip("/")

    return DEFAULT_SERVER_URL


def get_api_key(context=None):
    prefs = get_addon_preferences(context)
    if prefs and prefs.api_key:
        return prefs.api_key.strip()

    return ""


def get_animation_output_dir(context=None):
    prefs = get_addon_preferences(context)
    if prefs and prefs.animation_output_dir:
        return bpy.path.abspath(prefs.animation_output_dir)

    return os.path.join(os.path.expanduser("~"), "Desktop")


def auth_headers(context=None, content_type=None):
    headers = {}
    api_key = get_api_key(context)
    if api_key:
        headers['Authorization'] = f"Bearer {api_key}"
    if content_type:
        headers['Content-Type'] = content_type
    return headers


def resolve_download_url(download_url, context=None):
    if not download_url:
        return ""
    if download_url.startswith("/"):
        return f"{get_server_url(context)}{download_url}"
    return download_url


def download_authenticated_file(download_url, save_path, context=None):
    req = urllib.request.Request(resolve_download_url(download_url, context), headers=auth_headers(context))
    with urllib.request.urlopen(req) as response, open(save_path, 'wb') as output_file:
        output_file.write(response.read())


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


def parse_maybe_json(value):
    if not isinstance(value, str):
        return value
    try:
        return json.loads(value)
    except Exception:
        return value


def first_text(*values):
    for value in values:
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def extract_render_error_message(error):
    parsed = parse_maybe_json(error)
    if isinstance(parsed, str):
        return parsed
    if not isinstance(parsed, dict):
        return ""

    output = parsed.get("output") if isinstance(parsed.get("output"), dict) else {}
    return first_text(
        parsed.get("user_message"),
        parsed.get("userMessage"),
        parsed.get("message"),
        parsed.get("error_message"),
        parsed.get("error"),
        output.get("message"),
        output.get("error"),
    )


def sanitize_render_error(error, fallback="Render failed while processing the scene."):
    raw_message = extract_render_error_message(error) or fallback
    normalized = " ".join(str(raw_message).split())
    lower_message = normalized.lower()

    if "blender stopped" in lower_message or "blender crashed" in lower_message or "exit code" in lower_message or "signal" in lower_message:
        return "Blender stopped unexpectedly while rendering this scene. Try lowering samples, resolution, or texture sizes before submitting again."

    if not normalized or any(marker in lower_message for marker in INTERNAL_RENDER_ERROR_MARKERS):
        return fallback

    return normalized[:320]


def get_service_max_upload_bytes(context=None):
    try:
        log_verbose("Fetching upload limit", context, server=get_server_url(context))
        req = urllib.request.Request(f"{get_server_url(context)}/api/config")
        with urllib.request.urlopen(req, timeout=10) as response:
            data = json.loads(response.read().decode())
            max_upload_bytes = data.get("limits", {}).get("maxUploadBytes")
            if isinstance(max_upload_bytes, int) and max_upload_bytes > 0:
                log_verbose("Upload limit loaded", context, max_upload_bytes=max_upload_bytes)
                return max_upload_bytes
    except Exception as exc:
        log_verbose("Could not fetch upload limit; using default", context, error=exc)

    return DEFAULT_MAX_UPLOAD_BYTES


def remove_temp_payload(temp_path):
    try:
        if temp_path and os.path.exists(temp_path):
            os.remove(temp_path)
            log_verbose("Removed temporary payload", path=temp_path)
    except Exception as exc:
        log_verbose("Could not remove temporary payload", error=exc)


def get_guided_wall(scene):
    wall = getattr(scene, "rendersphere_guided_wall", "AUTH")
    if wall not in GUIDED_WALL_ORDER:
        return "AUTH"
    return wall


def set_guided_wall(scene, wall):
    if wall not in GUIDED_WALL_ORDER:
        wall = "AUTH"
    scene.rendersphere_guided_wall = wall
    log_verbose("Guided wall changed", wall=wall)
    force_ui_redraw()


def get_wall_index(wall):
    try:
        return GUIDED_WALL_ORDER.index(wall)
    except ValueError:
        return 0


def can_submit_render(context):
    return current_job_id is None and current_status in READY_RENDER_STATUSES and bool(get_api_key(context))


def get_frame_step(scene):
    if not getattr(scene, "runpod_advanced_mode", False):
        return 1
    return max(1, int(getattr(scene, "runpod_frame_step", 1)))


def get_render_frame_count(scene):
    start_frame, end_frame = get_render_frame_range(scene)
    if not scene.runpod_is_animation:
        return 1
    return ((end_frame - start_frame) // get_frame_step(scene)) + 1


def calculate_progress_percent(scene):
    target_samples = scene.runpod_samples
    if current_status not in ACTIVE_RENDER_STATUSES:
        if current_status in ["Render Complete.", "Zip saved."]:
            return 100
        return 0

    if current_status == "In Queue...":
        return 3

    if is_current_job_animation:
        total_frames = ((current_end_frame - current_start_frame) // max(current_frame_step, 1)) + 1
        completed_frame_index = max(0, (ui_frame_current - current_start_frame) // max(current_frame_step, 1))
        frame_pct = (completed_frame_index + 1) / max(total_frames, 1)
        sample_pct = ui_sample_current / max(target_samples, 1)
        pct = int(((completed_frame_index + sample_pct) / max(total_frames, 1)) * 100) if ui_sample_current else int(frame_pct * 100)
    else:
        pct = int((ui_sample_current / max(target_samples, 1)) * 100)

    return min(100, max(0, pct))




def get_missing_external_files():
    missing_files = []
    for img in bpy.data.images:
        if img.source in {'FILE', 'SEQUENCE', 'MOVIE'} and img.filepath:
            abs_path = bpy.path.abspath(img.filepath)
            if not os.path.exists(abs_path):
                missing_files.append(img.name)
    return missing_files


def get_render_frame_range(scene):
    target_scene = scene.runpod_scene or scene
    start_frame = target_scene.frame_start if scene.runpod_use_scene_frames else scene.runpod_frame_start
    end_frame = target_scene.frame_end if scene.runpod_use_scene_frames else scene.runpod_frame_end
    return start_frame, end_frame if scene.runpod_is_animation else start_frame


def selected_render_scene(scene):
    return scene.runpod_scene or scene


def selected_render_camera(scene):
    return scene.runpod_camera or selected_render_scene(scene).camera


def describe_render_job(scene):
    start_frame, end_frame = get_render_frame_range(scene)
    frame_count = get_render_frame_count(scene)
    render_type = "Animation" if scene.runpod_is_animation else "Still frame"
    target_scene = selected_render_scene(scene)
    target_camera = selected_render_camera(scene)
    return {
        "render_type": render_type,
        "start_frame": start_frame,
        "end_frame": end_frame,
        "frame_count": frame_count,
        "frame_step": get_frame_step(scene),
        "samples": scene.runpod_samples,
        "resolution_pct": scene.runpod_resolution_pct,
        "format": scene.runpod_output_format,
        "scene": target_scene.name if target_scene else "Current scene",
        "camera": target_camera.name if target_camera else "Scene camera",
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
            log_verbose("Polling render status", job_id=current_job_id)
            req = urllib.request.Request(status_endpoint, headers=auth_headers())
            with urllib.request.urlopen(req) as response:
                data = json.loads(response.read().decode())
                status = data.get("status")
                log_verbose("Received render status", job_id=current_job_id, status=status)

                if status in ["IN_QUEUE", "IN_PROGRESS", "RUNNING"]:
                    if status == "IN_QUEUE":
                        set_status("In Queue...")
                    else:
                        set_status("Rendering Animation..." if is_current_job_animation else "Rendering Frame...")

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
                    if not download_url:
                        current_error_msg = "Render completed but no download URL was returned."
                        set_status("Render Failed")
                        current_job_id = None
                        force_ui_redraw()
                        return None

                    if is_current_job_animation:
                        output_dir = get_animation_output_dir()
                        os.makedirs(output_dir, exist_ok=True)
                        zip_path = os.path.join(output_dir, f"animation_{current_job_id[:6]}.zip")
                        log_verbose("Downloading completed animation", job_id=current_job_id, path=zip_path)
                        download_authenticated_file(download_url, zip_path)
                        set_status("Zip saved.")
                    else:
                        save_path = os.path.join(bpy.app.tempdir, f"cloud_render_final.{current_download_extension}")
                        log_verbose("Downloading completed frame", job_id=current_job_id, path=save_path)
                        download_authenticated_file(download_url, save_path)
                        img = bpy.data.images.load(save_path)

                        for window in bpy.context.window_manager.windows:
                            for area in window.screen.areas:
                                if area.type == 'IMAGE_EDITOR':
                                    area.spaces.active.image = img
                        set_status("Render Complete.")

                    current_job_id = None
                    force_ui_redraw()
                    return None

                elif status == "FAILED":
                    raw_error = data.get("error") or data.get("message") or data.get("job", {}).get("error")
                    current_error_msg = sanitize_render_error(raw_error, "Render failed while processing the scene.")
                    log_verbose("Render failed", job_id=current_job_id, error=current_error_msg)
                    set_status("Render Failed")
                    current_job_id = None
                    force_ui_redraw()
                    return None

                elif status == "CANCELLED":
                    set_status("Cancelled.")
                    current_job_id = None
                    force_ui_redraw()
                    return None
                    
                else:
                    set_status(f"Error: {status}")
                    current_job_id = None
                    force_ui_redraw()
                    return None

        except Exception as e:
            log_verbose("Status check failed", error=e)

    return 1.0


class RENDERSPHERE_AddonPreferences(bpy.types.AddonPreferences):
    bl_idname = __package__ if __package__ else __name__

    server_url: bpy.props.StringProperty(
        name="Server URL",
        description="RenderSphere service URL",
        default=DEFAULT_SERVER_URL,
    )
    api_key: bpy.props.StringProperty(
        name="Access Key",
        description="RenderSphere access key from your dashboard",
        default="",
        subtype='PASSWORD',
    )
    animation_output_dir: bpy.props.StringProperty(
        name="Animation Download Folder",
        description="Folder used for completed animation zip downloads",
        default="",
        subtype='DIR_PATH',
    )
    verbose_logging: bpy.props.BoolProperty(
        name="Verbose Logging",
        description="Print detailed RenderSphere extension activity to the Blender console",
        default=True,
    )

    def draw(self, context):
        layout = self.layout
        layout.label(text=f"RenderSphere Add-on v{ADDON_VERSION}")
        layout.prop(self, "server_url")
        layout.prop(self, "api_key")
        layout.prop(self, "animation_output_dir")
        layout.prop(self, "verbose_logging")
        layout.operator("rendersphere.test_connection", icon='URL')


class RENDERSPHERE_OT_test_connection(bpy.types.Operator):
    bl_idname = "rendersphere.test_connection"
    bl_label = "Test RenderSphere Connection"
    bl_options = {'REGISTER'}

    def execute(self, context):
        global current_error_msg

        log_verbose("Testing account connection", context, server=get_server_url(context))
        if not get_api_key(context):
            current_error_msg = "Add your RenderSphere access key before testing."
            log_verbose("Connection test blocked: missing access key", context)
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
            log_verbose("Connection test succeeded", context, account=email)
            set_status("Connection OK")
            self.report({'INFO'}, f"Connected as {email}")
            return {'FINISHED'}
        except Exception as exc:
            current_error_msg = describe_url_error(exc)
            log_verbose("Connection test failed", context, error=current_error_msg)
            set_status("Render Failed")
            self.report({'ERROR'}, current_error_msg)
            return {'CANCELLED'}


class RENDERSPHERE_OT_unlock(bpy.types.Operator):
    bl_idname = "rendersphere.unlock"
    bl_label = "Unlock RenderSphere"
    bl_options = {'REGISTER'}

    def execute(self, context):
        global current_error_msg

        prefs = get_addon_preferences(context)
        log_verbose("Connecting account", context, server=get_server_url(context))
        if not prefs:
            current_error_msg = "Could not find RenderSphere add-on preferences."
            log_verbose("Connect blocked: preferences unavailable", context)
            self.report({'ERROR'}, current_error_msg)
            return {'CANCELLED'}

        if not get_api_key(context):
            current_error_msg = "Enter your RenderSphere access key."
            log_verbose("Connect blocked: missing access key", context)
            self.report({'ERROR'}, current_error_msg)
            set_status("Render Failed")
            return {'CANCELLED'}

        try:
            req = urllib.request.Request(f"{get_server_url(context)}/api/auth/me", headers=auth_headers(context))
            with urllib.request.urlopen(req, timeout=15) as response:
                data = json.loads(response.read().decode())
                user = data.get("user", {})
                email = user.get("email", "account")

            try:
                bpy.ops.wm.save_userpref()
            except Exception as exc:
                log_verbose("Could not save user preferences after connect", context, error=exc)

            current_error_msg = ""
            log_verbose("Account connected", context, account=email)
            set_status("Connection OK")
            set_guided_wall(context.scene, "TARGET")
            self.report({'INFO'}, f"RenderSphere connected for {email}")
            return {'FINISHED'}
        except Exception as exc:
            current_error_msg = describe_url_error(exc)
            log_verbose("Account connect failed", context, error=current_error_msg)
            set_status("Render Failed")
            self.report({'ERROR'}, current_error_msg)
            return {'CANCELLED'}


class RENDERSPHERE_OT_clear_access_key(bpy.types.Operator):
    bl_idname = "rendersphere.clear_access_key"
    bl_label = "Sign Out"
    bl_options = {'REGISTER'}

    def execute(self, context):
        prefs = get_addon_preferences(context)
        if prefs:
            prefs.api_key = ""
            try:
                bpy.ops.wm.save_userpref()
            except Exception as exc:
                log_verbose("Could not save user preferences after sign out", context, error=exc)

        log_verbose("Access key cleared", context)
        reset_job_state()
        set_guided_wall(context.scene, "AUTH")
        self.report({'INFO'}, "RenderSphere access key removed.")
        return {'FINISHED'}


class RENDERSPHERE_OT_goto_wall(bpy.types.Operator):
    bl_idname = "rendersphere.goto_wall"
    bl_label = "Open Guided Step"
    bl_options = {'REGISTER'}

    wall: bpy.props.EnumProperty(items=GUIDED_WALL_ITEMS)

    def execute(self, context):
        set_guided_wall(context.scene, self.wall)
        return {'FINISHED'}


class RENDERSPHERE_OT_next_wall(bpy.types.Operator):
    bl_idname = "rendersphere.next_wall"
    bl_label = "Next Step"
    bl_options = {'REGISTER'}

    def execute(self, context):
        scene = context.scene
        current_index = get_wall_index(get_guided_wall(scene))
        next_index = min(current_index + 1, len(GUIDED_WALL_ORDER) - 1)
        set_guided_wall(scene, GUIDED_WALL_ORDER[next_index])
        return {'FINISHED'}


class RENDERSPHERE_OT_previous_wall(bpy.types.Operator):
    bl_idname = "rendersphere.previous_wall"
    bl_label = "Previous Step"
    bl_options = {'REGISTER'}

    def execute(self, context):
        scene = context.scene
        current_index = get_wall_index(get_guided_wall(scene))
        previous_index = max(current_index - 1, 0)
        set_guided_wall(scene, GUIDED_WALL_ORDER[previous_index])
        return {'FINISHED'}


class RENDER_OT_cloud_upload(bpy.types.Operator):
    bl_idname = "render.cloud_upload"
    bl_label = "Submit Render"
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
        layout.label(text=f"Scene: {summary['scene']}")
        layout.label(text=f"Camera: {summary['camera']}")
        layout.label(text=f"Samples: {summary['samples']}")
        layout.label(text=f"Resolution: {summary['resolution_pct']}%")
        layout.label(text=f"Format: {summary['format']}")
        layout.separator()
        layout.label(text="This will use render credits if the job starts.")

    def execute(self, context):
        global current_job_id, job_start_time, last_api_check, current_error_msg
        global is_current_job_animation, current_start_frame, current_end_frame, current_frame_step, current_download_extension
        global ui_frame_current, ui_sample_current

        scene = context.scene
        server_url = get_server_url(context)
        log_verbose("Preparing render submission", context, server=server_url)
        if not get_api_key(context):
            current_error_msg = "Add your RenderSphere access key in the add-on preferences."
            log_verbose("Render submission blocked: missing access key", context)
            set_status("Render Failed")
            set_guided_wall(scene, "AUTH")
            return {'CANCELLED'}

        missing_files = get_missing_external_files()
        if missing_files and not self.ignore_missing:
            current_error_msg = "Missing external files must be acknowledged before rendering."
            log_verbose("Render submission blocked: missing external files", context, missing_count=len(missing_files))
            set_status("Render Failed")
            return {'CANCELLED'}

        start_frame, end_frame = get_render_frame_range(scene)
        target_scene = selected_render_scene(scene)
        target_camera = selected_render_camera(scene)

        if end_frame < start_frame:
            current_error_msg = "End frame must be greater than or equal to start frame."
            log_verbose("Render submission blocked: invalid frame range", context, start_frame=start_frame, end_frame=end_frame)
            set_status("Render Failed")
            return {'CANCELLED'}

        current_start_frame = start_frame
        current_end_frame = end_frame if scene.runpod_is_animation else start_frame
        current_frame_step = get_frame_step(scene)
        current_download_extension = OUTPUT_EXTENSIONS.get(scene.runpod_output_format, "png")
        ui_frame_current = start_frame
        ui_sample_current = 0
        current_error_msg = ""

        set_status("Packing .blend file...")
        try:
            log_verbose("Packing external files", context)
            bpy.ops.file.pack_all()
        except RuntimeError as e:
            log_verbose("Skipped packing some files", context, error=e)

        temp_path = os.path.join(bpy.app.tempdir, "rendersphere_payload.blend")
        log_verbose("Saving temporary payload", context, path=temp_path)
        bpy.ops.wm.save_as_mainfile(filepath=temp_path, copy=True)
        file_size = os.path.getsize(temp_path)
        max_upload_bytes = get_service_max_upload_bytes(context)
        log_verbose("Temporary payload ready", context, file_size=file_size, max_upload_bytes=max_upload_bytes)

        if file_size > max_upload_bytes:
            current_error_msg = f"Packed file is larger than {max_upload_bytes // (1024 * 1024)} MB."
            set_status("Render Failed")
            remove_temp_payload(temp_path)
            return {'CANCELLED'}

        set_status("Securing upload link...")
        api_endpoint = f"{server_url}/api/get-upload-url"
        payload = json.dumps({
            "fileName": "rendersphere_payload.blend",
            "fileSizeBytes": file_size,
        }).encode('utf-8')

        try:
            log_verbose("Requesting secure upload link", context, endpoint=api_endpoint, file_size=file_size)
            req = urllib.request.Request(api_endpoint, data=payload, headers=auth_headers(context, 'application/json'))
            with urllib.request.urlopen(req) as response:
                res_data = json.loads(response.read().decode())
                upload_url = res_data.get("uploadUrl")
                file_key = res_data.get("key")
            log_verbose("Secure upload link received", context, has_upload_url=bool(upload_url), has_file_key=bool(file_key))
        except Exception as e:
            current_error_msg = describe_url_error(e)
            log_verbose("Upload link request failed", context, error=current_error_msg)
            set_status("Render Failed")
            remove_temp_payload(temp_path)
            return {'CANCELLED'}

        set_status("Uploading to cloud...")
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
                log_verbose("Payload upload completed", context, status=upload_res.status)
                set_status("Starting render worker...")

                is_current_job_animation = scene.runpod_is_animation

                trigger_endpoint = f"{server_url}/api/trigger-render"
                project_id = scene.runpod_project.strip()
                if not project_id or project_id == "NONE":
                    project_id = None

                trigger_payload = {
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
                    "scene": target_scene.name if target_scene else "",
                    "camera": target_camera.name if target_camera else "",
                    "projectId": project_id,
                    "advancedMode": scene.runpod_advanced_mode,
                }

                if scene.runpod_advanced_mode:
                    trigger_payload.update({
                        "gpuDeviceType": scene.runpod_gpu_device_type,
                        "allowCpuFallback": scene.runpod_allow_cpu_fallback,
                        "transparentFilm": scene.runpod_transparent_film,
                        "usePersistentData": scene.runpod_use_persistent_data,
                        "frameStep": get_frame_step(scene),
                        "viewTransform": scene.runpod_view_transform,
                        "look": scene.runpod_look,
                        "exposure": scene.runpod_exposure,
                        "gamma": scene.runpod_gamma,
                        "maxBounces": scene.runpod_max_bounces,
                        "diffuseBounces": scene.runpod_diffuse_bounces,
                        "glossyBounces": scene.runpod_glossy_bounces,
                        "transmissionBounces": scene.runpod_transmission_bounces,
                        "transparentBounces": scene.runpod_transparent_bounces,
                        "causticsReflective": scene.runpod_caustics_reflective,
                        "causticsRefractive": scene.runpod_caustics_refractive,
                        "useSimplify": scene.runpod_use_simplify,
                        "simplifySubdivisions": scene.runpod_simplify_subdivisions,
                        "simplifyTextureLimit": scene.runpod_simplify_texture_limit,
                    })

                trigger_payload = json.dumps(trigger_payload).encode('utf-8')

                trigger_req = urllib.request.Request(trigger_endpoint, data=trigger_payload, headers=auth_headers(context, 'application/json'))

                log_verbose("Triggering render job", context, endpoint=trigger_endpoint, is_animation=is_current_job_animation, start_frame=start_frame, end_frame=end_frame)
                with urllib.request.urlopen(trigger_req) as trigger_response:
                    job_data = json.loads(trigger_response.read().decode())
                    current_job_id = job_data.get("jobId")

                    job_start_time = time.time()
                    last_api_check = time.time() - 5.0

                    log_verbose("Render job created", context, job_id=current_job_id)
                    set_status("In Queue...")
                    set_guided_wall(scene, "PROGRESS")
                    bpy.app.timers.register(check_job_status, first_interval=1.0)

            else:
                current_error_msg = f"Upload failed with status {upload_res.status}."
                log_verbose("Payload upload failed", context, status=upload_res.status)
                set_status("Render Failed")
                remove_temp_payload(temp_path)
                return {'CANCELLED'}
        except Exception as e:
            current_error_msg = describe_url_error(e)
            log_verbose("Upload or render trigger failed", context, error=current_error_msg)
            set_status("Render Failed")
            remove_temp_payload(temp_path)
            return {'CANCELLED'}

        self.ignore_missing = False
        remove_temp_payload(temp_path)
        return {'FINISHED'}


class RENDER_OT_cancel_job(bpy.types.Operator):
    bl_idname = "render.cancel_job"
    bl_label = "Cancel Job"
    bl_options = {'REGISTER'}

    def execute(self, context):
        global current_job_id

        if not current_job_id:
            log_verbose("Cancel requested without an active job", context)
            reset_job_state()
            return {'CANCELLED'}

        job_id = current_job_id
        log_verbose("Cancelling render job", context, job_id=job_id)
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
            log_verbose("Cancel request completed", context, job_id=job_id)
        except Exception as e:
            log_verbose("Cancel request failed", context, error=e)
        finally:
            reset_job_state()
            set_guided_wall(context.scene, "PROGRESS")

        return {'FINISHED'}


def draw_guided_wall_progress(layout, context):
    scene = context.scene
    current_wall = get_guided_wall(scene)
    current_index = get_wall_index(current_wall)

    box = layout.box()
    box.label(text="Guided render setup", icon='SEQ_STRIP_META')
    box.label(text=f"Step {current_index + 1} of {len(GUIDED_WALL_ORDER)}")

    for index, (wall, label, description) in enumerate(GUIDED_WALL_ITEMS):
        icon = 'RADIOBUT_ON' if wall == current_wall else ('CHECKMARK' if index < current_index else 'RADIOBUT_OFF')
        row = box.row(align=True)
        op = row.operator("rendersphere.goto_wall", text=label, icon=icon)
        op.wall = wall
        if wall == current_wall:
            row.label(text=description)


def draw_guided_wall_nav(layout, context):
    scene = context.scene
    current_wall = get_guided_wall(scene)
    current_index = get_wall_index(current_wall)
    can_go_next = current_index < len(GUIDED_WALL_ORDER) - 1

    if current_wall == "AUTH" and not get_api_key(context):
        can_go_next = False

    row = layout.row(align=True)
    previous_row = row.row(align=True)
    previous_row.enabled = current_index > 0
    previous_row.operator("rendersphere.previous_wall", text="Previous", icon='TRIA_LEFT')

    next_row = row.row(align=True)
    next_row.enabled = can_go_next
    next_row.operator("rendersphere.next_wall", text="Next", icon='TRIA_RIGHT')


def draw_status_summary(layout, context):
    if current_status == "Idle" and not current_error_msg:
        return

    box = layout.box()
    if current_status == "Render Failed":
        box.label(text="Render failed", icon='ERROR')
        if current_error_msg:
            box.label(text=current_error_msg)
    else:
        icon = 'CHECKMARK' if current_status in ["Render Complete.", "Zip saved.", "Connection OK"] else 'TIME'
        box.label(text=current_status, icon=icon)
        if current_status in ACTIVE_RENDER_STATUSES or current_status in ["Render Complete.", "Zip saved."]:
            box.label(text=f"Elapsed: {current_elapsed_str}")


def draw_progress_details(layout, context):
    scene = context.scene
    pct = calculate_progress_percent(scene)
    target_samples = scene.runpod_samples

    box = layout.box()
    box.label(text="Render progress", icon='TIME')
    box.label(text=current_status if current_status != "Idle" else "No active render yet.")
    box.label(text=f"Progress: {pct}%")

    meter_blocks = 10
    filled_blocks = int((pct / 100) * meter_blocks)
    box.label(text="[" + "#" * filled_blocks + "-" * (meter_blocks - filled_blocks) + "]")

    if current_job_id:
        box.label(text=f"Job: {current_job_id[:8]}")
        box.label(text=f"Elapsed: {current_elapsed_str}")
        if ui_frame_current:
            box.label(text=f"Frame: {ui_frame_current}")
        if ui_sample_current:
            box.label(text=f"Sample: {ui_sample_current}/{target_samples}")
        box.operator("render.cancel_job", text="Cancel Render", icon='CANCEL')
    elif current_status in ["Render Complete.", "Zip saved."]:
        box.label(text="The completed output is ready.", icon='CHECKMARK')
    elif current_status == "Render Failed" and current_error_msg:
        box.label(text=current_error_msg, icon='ERROR')


def draw_auth_wall(layout, context):
    prefs = get_addon_preferences(context)
    box = layout.box()
    box.label(text="Connect your account", icon='KEY_HLT')
    box.label(text="Paste an access key from your RenderSphere dashboard.")

    if prefs:
        box.prop(prefs, "server_url", text="Server URL")
        box.prop(prefs, "api_key", text="Access Key")
        box.prop(prefs, "verbose_logging")

        row = box.row(align=True)
        row.operator("rendersphere.unlock", text="Connect", icon='KEY_HLT')
        row.operator("rendersphere.test_connection", text="Test", icon='URL')

    if get_api_key(context):
        connected = layout.box()
        connected.label(text="Access key saved", icon='CHECKMARK')
        connected.label(text=f"Server: {get_server_url(context)}")
        connected.operator("rendersphere.clear_access_key", text="Sign Out", icon='UNLINKED')
    elif current_status == "Render Failed" and current_error_msg:
        error_box = layout.box()
        error_box.label(text="Connection issue", icon='ERROR')
        error_box.label(text=current_error_msg)


def draw_advanced_toggle(layout, scene):
    box = layout.box()
    box.label(text="Power user controls", icon='PREFERENCES')
    box.prop(scene, "runpod_advanced_mode", text="Advanced Mode")
    if scene.runpod_advanced_mode:
        box.label(text="Advanced settings will be sent with this render.", icon='CHECKMARK')
    else:
        box.label(text="Keep this off for the safest guided defaults.")


def draw_target_wall(layout, context):
    scene = context.scene
    target_scene = selected_render_scene(scene)
    target_camera = selected_render_camera(scene)

    draw_advanced_toggle(layout, scene)

    box = layout.box()
    box.label(text="Choose render target", icon='SCENE_DATA')
    box.prop(scene, "runpod_scene", text="Scene")
    box.prop(scene, "runpod_camera", text="Camera")
    box.prop(scene, "runpod_project", text="Project ID")

    if scene.runpod_advanced_mode:
        advanced = layout.box()
        advanced.label(text="Advanced worker settings", icon='CONSOLE')
        advanced.prop(scene, "runpod_gpu_device_type", text="GPU Backend")
        advanced.prop(scene, "runpod_allow_cpu_fallback", text="Allow CPU Fallback")

    summary = layout.box()
    summary.label(text="Target summary", icon='INFO')
    summary.label(text=f"Scene: {target_scene.name if target_scene else 'Current scene'}")
    summary.label(text=f"Camera: {target_camera.name if target_camera else 'Scene camera'}")
    summary.label(text="Leave Project ID empty to submit without a project.")


def draw_output_wall(layout, context):
    scene = context.scene
    prefs = get_addon_preferences(context)

    draw_advanced_toggle(layout, scene)

    image_box = layout.box()
    image_box.label(text="Output settings", icon='OUTPUT')
    image_box.prop(scene, "runpod_output_format", text="File Format")
    image_box.prop(scene, "runpod_resolution_pct", text="Resolution %")

    if scene.runpod_advanced_mode:
        color_box = layout.box()
        color_box.label(text="Advanced color and film", icon='IMAGE_DATA')
        color_box.prop(scene, "runpod_transparent_film", text="Transparent Film")
        color_box.prop(scene, "runpod_view_transform", text="View Transform")
        color_box.prop(scene, "runpod_look", text="Look")
        row = color_box.row(align=True)
        row.prop(scene, "runpod_exposure", text="Exposure")
        row.prop(scene, "runpod_gamma", text="Gamma")

    range_box = layout.box()
    range_box.label(text="Frame range", icon='RENDER_ANIMATION')
    range_box.prop(scene, "runpod_is_animation", text="Render Animation")
    if scene.runpod_is_animation:
        range_box.prop(scene, "runpod_use_scene_frames", text="Use Scene Frame Range")
        row = range_box.row(align=True)
        row.enabled = not scene.runpod_use_scene_frames
        row.prop(scene, "runpod_frame_start", text="Start")
        row.prop(scene, "runpod_frame_end", text="End")
        if scene.runpod_advanced_mode:
            range_box.prop(scene, "runpod_frame_step", text="Frame Step")
        if prefs:
            range_box.prop(prefs, "animation_output_dir", text="Download Folder")
    else:
        range_box.label(text=f"Still frame: {selected_render_scene(scene).frame_current if selected_render_scene(scene) else scene.frame_current}")


def draw_quality_wall(layout, context):
    scene = context.scene

    draw_advanced_toggle(layout, scene)

    box = layout.box()
    box.label(text="Render quality", icon='SETTINGS')
    box.prop(scene, "runpod_engine", text="Engine")
    box.prop(scene, "runpod_samples", text="Samples")

    if scene.runpod_engine == 'CYCLES':
        box.separator()
        box.prop(scene, "runpod_denoiser", text="Denoiser")
        box.prop(scene, "runpod_noise_threshold", text="Noise Threshold")

        if scene.runpod_advanced_mode:
            cycles_box = layout.box()
            cycles_box.label(text="Advanced Cycles", icon='MOD_PHYSICS')
            cycles_box.prop(scene, "runpod_use_persistent_data", text="Persistent Data")
            cycles_box.prop(scene, "runpod_max_bounces", text="Max Bounces")
            row = cycles_box.row(align=True)
            row.prop(scene, "runpod_diffuse_bounces", text="Diffuse")
            row.prop(scene, "runpod_glossy_bounces", text="Glossy")
            row = cycles_box.row(align=True)
            row.prop(scene, "runpod_transmission_bounces", text="Transmission")
            row.prop(scene, "runpod_transparent_bounces", text="Transparent")
            cycles_box.prop(scene, "runpod_caustics_reflective", text="Reflective Caustics")
            cycles_box.prop(scene, "runpod_caustics_refractive", text="Refractive Caustics")

    if scene.runpod_advanced_mode:
        perf_box = layout.box()
        perf_box.label(text="Advanced performance", icon='MEMORY')
        perf_box.prop(scene, "runpod_use_simplify", text="Use Simplify")
        if scene.runpod_use_simplify:
            perf_box.prop(scene, "runpod_simplify_subdivisions", text="Max Subdivision")
            perf_box.prop(scene, "runpod_simplify_texture_limit", text="Texture Limit")


def draw_review_wall(layout, context):
    scene = context.scene
    summary = describe_render_job(scene)
    missing_files = get_missing_external_files()

    box = layout.box()
    box.label(text="Review render job", icon='RENDER_STILL')
    box.label(text=f"Type: {summary['render_type']}")
    box.label(text=f"Frames: {summary['start_frame']} - {summary['end_frame']} ({summary['frame_count']} total)")
    box.label(text=f"Scene: {summary['scene']}")
    box.label(text=f"Camera: {summary['camera']}")
    box.label(text=f"Samples: {summary['samples']}")
    box.label(text=f"Resolution: {summary['resolution_pct']}%")
    box.label(text=f"Format: {summary['format']}")
    if scene.runpod_advanced_mode:
        box.label(text=f"Frame step: {summary['frame_step']}")
        box.label(text=f"GPU backend: {scene.runpod_gpu_device_type}")
        box.label(text="Advanced mode: On")

    if missing_files:
        warning = layout.box()
        warning.label(text="Missing external files", icon='ERROR')
        warning.label(text=", ".join(missing_files[:4]))
        if len(missing_files) > 4:
            warning.label(text=f"and {len(missing_files) - 4} more")
        warning.label(text="The final render may have missing textures.")

    submit_box = layout.box()
    submit_box.label(text="Ready to submit", icon='CHECKMARK' if can_submit_render(context) else 'ERROR')
    if not get_api_key(context):
        submit_box.label(text="Connect your account before submitting.")
    elif current_job_id:
        submit_box.label(text="A render is already running.")
    else:
        submit_box.label(text="The next step will package, upload, and start rendering.")

    row = submit_box.row()
    row.enabled = can_submit_render(context)
    button_text = "Submit Animation" if scene.runpod_is_animation else "Submit Frame"
    row.operator("render.cloud_upload", text=button_text, icon='WORLD')


def draw_progress_wall(layout, context):
    draw_progress_details(layout, context)

    if current_status in ["Idle", "Connection OK", "Cancelled."]:
        hint = layout.box()
        hint.label(text="No render is currently running.", icon='INFO')
        hint.label(text="Submit from the review step to see live progress here.")
        hint.operator("rendersphere.goto_wall", text="Back to Review", icon='TRIA_LEFT').wall = "REVIEW"


class RENDER_PT_main_panel(bpy.types.Panel):
    bl_label = "RenderSphere Guided Render"
    bl_idname = "RENDER_PT_main_panel"
    bl_space_type = 'VIEW_3D'
    bl_region_type = 'UI'
    bl_category = 'RenderSphere'

    def draw(self, context):
        layout = self.layout
        scene = context.scene
        current_wall = get_guided_wall(scene)

        draw_guided_wall_progress(layout, context)
        layout.separator()

        wall_box = layout.box()
        wall_box.label(text=GUIDED_WALL_LABELS.get(current_wall, "Guided Step"), icon='RIGHTARROW')
        wall_box.label(text=GUIDED_WALL_DESCRIPTIONS.get(current_wall, "Configure this step."))

        if current_wall == "AUTH":
            draw_auth_wall(layout, context)
        elif current_wall == "TARGET":
            draw_target_wall(layout, context)
        elif current_wall == "OUTPUT":
            draw_output_wall(layout, context)
        elif current_wall == "QUALITY":
            draw_quality_wall(layout, context)
        elif current_wall == "REVIEW":
            draw_review_wall(layout, context)
        elif current_wall == "PROGRESS":
            draw_progress_wall(layout, context)

        draw_status_summary(layout, context)
        layout.separator()
        draw_guided_wall_nav(layout, context)


class RENDER_PT_scene_panel(bpy.types.Panel):
    bl_label = "Scene"
    bl_idname = "RENDER_PT_scene_panel"
    bl_space_type = 'VIEW_3D'
    bl_region_type = 'UI'
    bl_category = 'RenderSphere'
    bl_parent_id = "RENDER_PT_main_panel"

    @classmethod
    def poll(cls, context):
        return False

    def draw(self, context):
        pass


class RENDER_PT_output_panel(bpy.types.Panel):
    bl_label = "Output"
    bl_idname = "RENDER_PT_output_panel"
    bl_space_type = 'VIEW_3D'
    bl_region_type = 'UI'
    bl_category = 'RenderSphere'
    bl_parent_id = "RENDER_PT_main_panel"

    @classmethod
    def poll(cls, context):
        return False

    def draw(self, context):
        pass


class RENDER_PT_quality_panel(bpy.types.Panel):
    bl_label = "Quality"
    bl_idname = "RENDER_PT_quality_panel"
    bl_space_type = 'VIEW_3D'
    bl_region_type = 'UI'
    bl_category = 'RenderSphere'
    bl_parent_id = "RENDER_PT_main_panel"

    @classmethod
    def poll(cls, context):
        return False

    def draw(self, context):
        pass


class RENDER_PT_account_panel(bpy.types.Panel):
    bl_label = "Account"
    bl_idname = "RENDER_PT_account_panel"
    bl_space_type = 'VIEW_3D'
    bl_region_type = 'UI'
    bl_category = 'RenderSphere'
    bl_parent_id = "RENDER_PT_main_panel"
    bl_options = {'DEFAULT_CLOSED'}

    @classmethod
    def poll(cls, context):
        return False

    def draw(self, context):
        pass


classes = (
    RENDERSPHERE_AddonPreferences,
    RENDERSPHERE_OT_test_connection,
    RENDERSPHERE_OT_unlock,
    RENDERSPHERE_OT_clear_access_key,
    RENDERSPHERE_OT_goto_wall,
    RENDERSPHERE_OT_next_wall,
    RENDERSPHERE_OT_previous_wall,
    RENDER_OT_cloud_upload,
    RENDER_OT_cancel_job,
    RENDER_PT_main_panel,
    RENDER_PT_scene_panel,
    RENDER_PT_output_panel,
    RENDER_PT_quality_panel,
    RENDER_PT_account_panel,
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
    bpy.types.Scene.runpod_advanced_mode = bpy.props.BoolProperty(
        name="Advanced Mode",
        description="Show power-user render controls and send them with this job",
        default=False
    )
    bpy.types.Scene.runpod_gpu_device_type = bpy.props.EnumProperty(
        name="GPU Backend",
        description="Preferred GPU backend for Cycles on the render worker",
        items=GPU_BACKEND_ITEMS,
        default='AUTO'
    )
    bpy.types.Scene.runpod_allow_cpu_fallback = bpy.props.BoolProperty(
        name="Allow CPU Fallback",
        description="Allow CPU rendering if GPU setup fails. Slower, but useful for diagnostics.",
        default=False
    )
    bpy.types.Scene.runpod_frame_step = bpy.props.IntProperty(
        name="Frame Step",
        description="Render every Nth frame for animation jobs",
        default=1,
        min=1,
        max=1000
    )
    bpy.types.Scene.runpod_transparent_film = bpy.props.BoolProperty(
        name="Transparent Film",
        description="Render with transparent film/background when supported",
        default=False
    )
    bpy.types.Scene.runpod_use_persistent_data = bpy.props.BoolProperty(
        name="Persistent Data",
        description="Keep render data in memory between frames for animation performance",
        default=True
    )
    bpy.types.Scene.runpod_view_transform = bpy.props.StringProperty(
        name="View Transform",
        description="Optional color management view transform. Leave empty to keep scene settings.",
        default=""
    )
    bpy.types.Scene.runpod_look = bpy.props.StringProperty(
        name="Look",
        description="Optional color management look. Leave empty to keep scene settings.",
        default=""
    )
    bpy.types.Scene.runpod_exposure = bpy.props.FloatProperty(
        name="Exposure",
        description="Color management exposure override",
        default=0.0,
        min=-10.0,
        max=10.0
    )
    bpy.types.Scene.runpod_gamma = bpy.props.FloatProperty(
        name="Gamma",
        description="Color management gamma override",
        default=1.0,
        min=0.01,
        max=5.0
    )
    bpy.types.Scene.runpod_max_bounces = bpy.props.IntProperty(
        name="Max Bounces",
        description="Cycles maximum light bounces",
        default=12,
        min=0,
        max=128
    )
    bpy.types.Scene.runpod_diffuse_bounces = bpy.props.IntProperty(
        name="Diffuse Bounces",
        default=4,
        min=0,
        max=128
    )
    bpy.types.Scene.runpod_glossy_bounces = bpy.props.IntProperty(
        name="Glossy Bounces",
        default=4,
        min=0,
        max=128
    )
    bpy.types.Scene.runpod_transmission_bounces = bpy.props.IntProperty(
        name="Transmission Bounces",
        default=12,
        min=0,
        max=128
    )
    bpy.types.Scene.runpod_transparent_bounces = bpy.props.IntProperty(
        name="Transparent Bounces",
        default=8,
        min=0,
        max=128
    )
    bpy.types.Scene.runpod_caustics_reflective = bpy.props.BoolProperty(
        name="Reflective Caustics",
        default=True
    )
    bpy.types.Scene.runpod_caustics_refractive = bpy.props.BoolProperty(
        name="Refractive Caustics",
        default=True
    )
    bpy.types.Scene.runpod_use_simplify = bpy.props.BoolProperty(
        name="Use Simplify",
        description="Enable Blender simplify settings on the render worker",
        default=False
    )
    bpy.types.Scene.runpod_simplify_subdivisions = bpy.props.IntProperty(
        name="Max Subdivision",
        default=2,
        min=0,
        max=12
    )
    bpy.types.Scene.runpod_simplify_texture_limit = bpy.props.EnumProperty(
        name="Texture Limit",
        description="Texture limit applied when simplify is enabled",
        items=[
            ('OFF', 'Off', ''),
            ('128', '128 px', ''),
            ('256', '256 px', ''),
            ('512', '512 px', ''),
            ('1024', '1024 px', ''),
            ('2048', '2048 px', ''),
            ('4096', '4096 px', ''),
        ],
        default='OFF'
    )
    
    bpy.types.Scene.runpod_scene = bpy.props.PointerProperty(
        name="Scene",
        type=bpy.types.Scene,
        description="Scene to render. Empty means the current scene."
    )
    bpy.types.Scene.runpod_camera = bpy.props.PointerProperty(
        name="Camera",
        type=bpy.types.Object,
        description="Camera to render from. Empty means the selected scene camera.",
        poll=lambda self, obj: obj.type == 'CAMERA'
    )
    bpy.types.Scene.runpod_project = bpy.props.StringProperty(
        name="Project ID",
        description="Optional dashboard project UUID. Leave empty to submit as unassigned.",
        default=""
    )
    bpy.types.Scene.rendersphere_guided_wall = bpy.props.EnumProperty(
        name="Guided Step",
        description="Current RenderSphere guided setup step",
        items=GUIDED_WALL_ITEMS,
        default='AUTH'
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
    del bpy.types.Scene.runpod_advanced_mode
    del bpy.types.Scene.runpod_gpu_device_type
    del bpy.types.Scene.runpod_allow_cpu_fallback
    del bpy.types.Scene.runpod_frame_step
    del bpy.types.Scene.runpod_transparent_film
    del bpy.types.Scene.runpod_use_persistent_data
    del bpy.types.Scene.runpod_view_transform
    del bpy.types.Scene.runpod_look
    del bpy.types.Scene.runpod_exposure
    del bpy.types.Scene.runpod_gamma
    del bpy.types.Scene.runpod_max_bounces
    del bpy.types.Scene.runpod_diffuse_bounces
    del bpy.types.Scene.runpod_glossy_bounces
    del bpy.types.Scene.runpod_transmission_bounces
    del bpy.types.Scene.runpod_transparent_bounces
    del bpy.types.Scene.runpod_caustics_reflective
    del bpy.types.Scene.runpod_caustics_refractive
    del bpy.types.Scene.runpod_use_simplify
    del bpy.types.Scene.runpod_simplify_subdivisions
    del bpy.types.Scene.runpod_simplify_texture_limit
    
    del bpy.types.Scene.runpod_scene
    del bpy.types.Scene.runpod_camera
    del bpy.types.Scene.runpod_project
    del bpy.types.Scene.rendersphere_guided_wall


if __name__ == "__main__":
    register()
