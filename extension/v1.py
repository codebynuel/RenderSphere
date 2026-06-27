bl_info = {
    "name": "RenderSphere Extension",
    "author": "Ella",
    "version": (1, 15, 0),
    "blender": (4, 0, 0),
    "location": "View3D > Sidebar > RenderSphere",
    "category": "Render",
}

import bpy
import os
import json
import ssl
import urllib.request
import urllib.error
import http.client
import time
import platform
from urllib.parse import urlparse

# Relaxed SSL for Cloudflare tunnel compatibility
ssl._create_default_https_context = ssl._create_unverified_context

DEFAULT_SERVER_URL = "https://plain-vids-topics-guestbook.trycloudflare.com"
DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024 * 1024
ADDON_VERSION = ".".join(str(part) for part in bl_info["version"])
LOG_PREFIX = "[RenderSphere]"

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

FLOW_ITEMS = [
    ('SETUP', 'Setup', 'Choose the account, project, scene, output, and quality'),
    ('REVIEW', 'Review', 'Review the job before credits are used'),
    ('SUBMITTING', 'Submitting', 'Packaging and uploading the .blend file'),
    ('RENDERING', 'Rendering', 'RenderSphere is rendering the job'),
    ('COMPLETE', 'Complete', 'The render finished successfully'),
    ('FAILED', 'Failed', 'The render failed or was cancelled'),
]

QUALITY_PRESET_ITEMS = [
    ('FAST', 'Fast', 'Lower samples for quick previews'),
    ('BALANCED', 'Balanced', 'Recommended default quality'),
    ('HIGH', 'High', 'Higher samples for final stills'),
    ('CUSTOM', 'Custom', 'Show sample, denoise, and advanced quality controls'),
]

RENDER_TYPE_ITEMS = [
    ('STILL', 'Still Frame', 'Render the current frame'),
    ('ANIMATION', 'Animation', 'Render a frame range and download a zip'),
]

ACTIVE_PHASES = {'packaging', 'uploading', 'submitted', 'rendering', 'downloading', 'cancelling'}
TERMINAL_PHASES = {'idle', 'connected', 'complete', 'failed', 'cancelled'}

# Shared state for background upload thread
_bg_upload = {
    'running': False,
    'done': False,
    'success': False,
    'phase': 'idle',
    'status': '',
    'error': '',
    'progress_pct': 0,
    'job_id': None,
    'file_key': None,
    'temp_path': None,
    'upload_url': None,
    'file_size': 0,
}

# Prevent multiple concurrent background uploads
_bg_upload_lock = False
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

QUALITY_PRESETS = {
    'FAST': {
        'samples': 64,
        'resolution_pct': 75,
        'denoiser': 'OPENIMAGEDENOISE',
        'noise_threshold': 0.05,
    },
    'BALANCED': {
        'samples': 128,
        'resolution_pct': 100,
        'denoiser': 'OPENIMAGEDENOISE',
        'noise_threshold': 0.02,
    },
    'HIGH': {
        'samples': 256,
        'resolution_pct': 100,
        'denoiser': 'OPENIMAGEDENOISE',
        'noise_threshold': 0.01,
    },
}

PROJECT_NONE_ITEM = ('NONE', 'No project', 'Submit without attaching the render to a dashboard project')
PROJECT_ITEMS = [PROJECT_NONE_ITEM]
PROJECT_ID_BY_ENUM = {'NONE': None}
PROJECT_LAST_REFRESH = 0.0


class RuntimeState:
    def __init__(self):
        self.job_id = None
        self.phase = 'idle'
        self.status = 'Ready to set up a render.'
        self.error = ''
        self.job_start_time = 0.0
        self.last_api_check = 0.0
        self.elapsed = '00:00'
        self.is_animation = False
        self.start_frame = 1
        self.end_frame = 1
        self.frame_step = 1
        self.download_extension = 'png'
        self.frame_current = 0
        self.sample_current = 0
        self.last_output_path = ''
        self.last_output_kind = ''
        self.connected_account = ''

    def reset_job(self, status='Ready to set up a render.', phase='idle'):
        self.job_id = None
        self.phase = phase
        self.status = status
        self.error = ''
        self.job_start_time = 0.0
        self.last_api_check = 0.0
        self.elapsed = '00:00'
        self.is_animation = False
        self.start_frame = 1
        self.end_frame = 1
        self.frame_step = 1
        self.download_extension = 'png'
        self.frame_current = 0
        self.sample_current = 0


STATE = RuntimeState()


# Compatibility aliases for older code paths and console diagnostics.
def __getattr__(name):
    if name == 'current_job_id':
        return STATE.job_id
    if name == 'current_status':
        return STATE.status
    if name == 'current_error_msg':
        return STATE.error
    if name == 'current_elapsed_str':
        return STATE.elapsed
    raise AttributeError(name)


def force_ui_redraw():
    for window in bpy.context.window_manager.windows:
        for area in window.screen.areas:
            if area.type in {'VIEW_3D', 'IMAGE_EDITOR'}:
                area.tag_redraw()


def verbose_logging_enabled(context=None):
    prefs = get_addon_preferences(context)
    if prefs and hasattr(prefs, 'verbose_logging'):
        return bool(prefs.verbose_logging)
    return True


def log_verbose(message, context=None, **details):
    if not verbose_logging_enabled(context):
        return

    timestamp = time.strftime('%H:%M:%S')
    suffix = ''
    if details:
        safe_details = []
        for key, value in details.items():
            if 'key' in key.lower() or 'token' in key.lower() or 'authorization' in key.lower():
                value = '<redacted>'
            safe_details.append(f"{key}={value}")
        suffix = ' | ' + ', '.join(safe_details)
    print(f"{LOG_PREFIX} {timestamp} | {message}{suffix}")


def get_addon_preferences(context=None):
    addon_keys = [key for key in {__package__, __name__} if key]
    context = context or bpy.context

    for addon_key in addon_keys:
        addon = context.preferences.addons.get(addon_key)
        if addon:
            return addon.preferences

    return None


def get_server_url(context=None):
    return DEFAULT_SERVER_URL


def get_api_key(context=None):
    prefs = get_addon_preferences(context)
    if prefs and prefs.api_key:
        return prefs.api_key.strip()
    return ''


def get_animation_output_dir(context=None):
    prefs = get_addon_preferences(context)
    if prefs and prefs.animation_output_dir:
        return bpy.path.abspath(prefs.animation_output_dir)
    return os.path.join(os.path.expanduser('~'), 'Desktop')


def auth_headers(context=None, content_type=None):
    headers = {}
    api_key = get_api_key(context)
    if api_key:
        headers['Authorization'] = f"Bearer {api_key}"
    if content_type:
        headers['Content-Type'] = content_type
    return headers


def set_flow_state(scene, flow_state):
    if scene and hasattr(scene, 'rendersphere_flow_state'):
        allowed = {item[0] for item in FLOW_ITEMS}
        scene.rendersphere_flow_state = flow_state if flow_state in allowed else 'SETUP'
    force_ui_redraw()


def set_status(text, phase=None, flow_state=None, error=None, context=None):
    STATE.status = text
    if phase:
        STATE.phase = phase
    if error is not None:
        STATE.error = error
    if flow_state == 'FAILED' and error:
        report_extension_error(error, job_id=STATE.job_id, details={'status_text': text})
    if flow_state:
        scene = context.scene if context else getattr(bpy.context, 'scene', None)
        set_flow_state(scene, flow_state)
    force_ui_redraw()
    log_verbose('Status updated', context, status=text, phase=STATE.phase, flow=flow_state)


def reset_job_state(status='Ready to set up a render.', context=None):
    log_verbose('Resetting job state', context, previous_job_id=STATE.job_id, next_status=status)
    STATE.reset_job(status=status)
    force_ui_redraw()


def can_submit_render(context):
    return STATE.job_id is None and STATE.phase in TERMINAL_PHASES and bool(get_api_key(context))


def is_busy():
    return STATE.job_id is not None or STATE.phase in ACTIVE_PHASES


def resolve_download_url(download_url, context=None):
    if not download_url:
        return ''
    if download_url.startswith('/'):
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
            message = data.get('error') or data.get('message') or body
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
    return ''


def extract_render_error_message(error):
    parsed = parse_maybe_json(error)
    if isinstance(parsed, str):
        return parsed
    if not isinstance(parsed, dict):
        return ''

    output = parsed.get('output') if isinstance(parsed.get('output'), dict) else {}
    return first_text(
        parsed.get('user_message'),
        parsed.get('userMessage'),
        parsed.get('message'),
        parsed.get('error_message'),
        parsed.get('error'),
        output.get('message'),
        output.get('error'),
    )


def sanitize_render_error(error, fallback='Render failed while processing the scene.'):
    raw_message = extract_render_error_message(error) or fallback
    normalized = ' '.join(str(raw_message).split())
    lower_message = normalized.lower()

    if 'blender stopped' in lower_message or 'blender crashed' in lower_message or 'exit code' in lower_message or 'signal' in lower_message:
        return 'Blender stopped unexpectedly while rendering this scene. Try lowering samples, resolution, or texture sizes before submitting again.'

    if not normalized or any(marker in lower_message for marker in INTERNAL_RENDER_ERROR_MARKERS):
        return fallback

    return normalized[:320]


def get_service_max_upload_bytes(context=None):
    try:
        log_verbose('Fetching upload limit', context, server=get_server_url(context))
        req = urllib.request.Request(f"{get_server_url(context)}/api/config")
        with urllib.request.urlopen(req, timeout=10) as response:
            data = json.loads(response.read().decode())
            max_upload_bytes = data.get('limits', {}).get('maxUploadBytes')
            if isinstance(max_upload_bytes, int) and max_upload_bytes > 0:
                log_verbose('Upload limit loaded', context, max_upload_bytes=max_upload_bytes)
                return max_upload_bytes
    except Exception as exc:
        log_verbose('Could not fetch upload limit; using default', context, error=exc)

    return DEFAULT_MAX_UPLOAD_BYTES


def report_extension_error(message, level='error', job_id=None, details=None):
    """Report an extension error to the RenderSphere server for admin visibility."""
    try:
        payload = json.dumps({
            'message': str(message)[:2000], 'level': level, 'jobId': job_id,
            'addonVersion': ADDON_VERSION, 'blenderVersion': bpy.app.version_string,
            'os': platform.system(), 'details': details or {},
            'email': STATE.connected_account.split(' · ')[0] if ' · ' in STATE.connected_account else (STATE.connected_account or None),
        }).encode()
        req = urllib.request.Request(
            f"{DEFAULT_SERVER_URL}/api/admin/extension-errors",
            data=payload, headers={'Content-Type': 'application/json'}
        )
        urllib.request.urlopen(req, timeout=5)
    except Exception:
        pass  # Don't let error-reporting errors cascade


def remove_temp_payload(temp_path):
    try:
        if temp_path and os.path.exists(temp_path):
            os.remove(temp_path)
            log_verbose('Removed temporary payload', path=temp_path)
    except Exception as exc:
        log_verbose('Could not remove temporary payload', error=exc)


def http_put_file(upload_url, temp_path, file_size):
    parsed_url = urlparse(upload_url)
    if parsed_url.scheme == 'http':
        connection = http.client.HTTPConnection(parsed_url.netloc)
    else:
        connection = http.client.HTTPSConnection(parsed_url.netloc, context=ssl._create_unverified_context())

    request_path = parsed_url.path
    if parsed_url.query:
        request_path += '?' + parsed_url.query

    try:
        with open(temp_path, 'rb') as file_data:
            connection.request(
                'PUT',
                request_path,
                body=file_data,
                headers={'Content-Type': 'application/octet-stream', 'Content-Length': str(file_size)},
            )
            return connection.getresponse()
    finally:
        try:
            connection.close()
        except Exception:
            pass


def apply_quality_preset(self, context):
    scene = context.scene if context else self
    preset = getattr(scene, 'runpod_quality_preset', 'BALANCED')
    values = QUALITY_PRESETS.get(preset)
    if not values:
        return

    scene.runpod_samples = values['samples']
    scene.runpod_resolution_pct = values['resolution_pct']
    scene.runpod_denoiser = values['denoiser']
    scene.runpod_noise_threshold = values['noise_threshold']
    log_verbose('Quality preset applied', context, preset=preset)


def sync_render_type(self, context):
    scene = context.scene if context else self
    scene.runpod_is_animation = getattr(scene, 'runpod_render_type', 'STILL') == 'ANIMATION'


def should_show_quality_controls(scene):
    return scene.runpod_quality_preset == 'CUSTOM' or scene.runpod_advanced_mode


def should_show_advanced_controls(scene):
    return scene.runpod_advanced_mode


def project_items(self, context):
    return PROJECT_ITEMS if PROJECT_ITEMS else [PROJECT_NONE_ITEM]


def project_enum_identifier(project_id):
    safe_chars = []
    for char in str(project_id).upper():
        if char.isascii() and char.isalnum():
            safe_chars.append(char)
        else:
            safe_chars.append('_')

    safe_id = ''.join(safe_chars).strip('_') or 'ID'
    return f"PROJECT_{safe_id[:48]}"


def get_selected_project_id(scene):
    project_key = getattr(scene, 'runpod_project', 'NONE') or 'NONE'
    if project_key == 'NONE':
        return None
    if project_key in PROJECT_ID_BY_ENUM:
        return PROJECT_ID_BY_ENUM[project_key]
    return project_key


def get_selected_project_label(scene):
    project_key = getattr(scene, 'runpod_project', 'NONE') or 'NONE'
    return next((item[1] for item in PROJECT_ITEMS if item[0] == project_key), 'No project')


def set_project_items(projects):
    global PROJECT_ITEMS, PROJECT_ID_BY_ENUM, PROJECT_LAST_REFRESH
    items = [PROJECT_NONE_ITEM]
    id_by_enum = {'NONE': None}
    seen_project_ids = set()
    seen_enum_ids = {'NONE'}

    for project in projects:
        if not isinstance(project, dict):
            continue

        project_id = str(project.get('id') or '').strip()
        if not project_id or project_id in seen_project_ids:
            continue

        enum_id = project_enum_identifier(project_id)
        if enum_id in seen_enum_ids:
            suffix = 2
            base_enum_id = enum_id[:55]
            while f"{base_enum_id}_{suffix}" in seen_enum_ids:
                suffix += 1
            enum_id = f"{base_enum_id}_{suffix}"

        name = str(project.get('name') or project_id).strip() or project_id
        description = f"Dashboard project: {name}"
        items.append((enum_id, name[:64], description[:256]))
        id_by_enum[enum_id] = project_id
        seen_project_ids.add(project_id)
        seen_enum_ids.add(enum_id)

    PROJECT_ITEMS = items or [PROJECT_NONE_ITEM]
    PROJECT_ID_BY_ENUM = id_by_enum
    PROJECT_LAST_REFRESH = time.time()


def fetch_projects(context=None):
    req = urllib.request.Request(f"{get_server_url(context)}/api/projects", headers=auth_headers(context))
    with urllib.request.urlopen(req, timeout=15) as response:
        data = json.loads(response.read().decode())
    projects = data.get('projects', [])
    if not isinstance(projects, list):
        projects = []
    set_project_items(projects)
    return projects


def get_missing_external_files():
    missing_files = []
    for img in bpy.data.images:
        if img.source in {'FILE', 'SEQUENCE', 'MOVIE'} and img.filepath:
            abs_path = bpy.path.abspath(img.filepath)
            if not os.path.exists(abs_path):
                missing_files.append(img.name)
    return missing_files


def selected_render_scene(scene):
    return scene.runpod_scene or scene


def selected_render_camera(scene):
    return scene.runpod_camera or selected_render_scene(scene).camera


def get_frame_step(scene):
    if not should_show_advanced_controls(scene):
        return 1
    return max(1, int(getattr(scene, 'runpod_frame_step', 1)))


def get_render_frame_range(scene):
    target_scene = selected_render_scene(scene)
    if not scene.runpod_is_animation:
        return target_scene.frame_current, target_scene.frame_current

    start_frame = target_scene.frame_start if scene.runpod_use_scene_frames else scene.runpod_frame_start
    end_frame = target_scene.frame_end if scene.runpod_use_scene_frames else scene.runpod_frame_end
    return start_frame, end_frame


def get_render_frame_count(scene):
    start_frame, end_frame = get_render_frame_range(scene)
    if not scene.runpod_is_animation:
        return 1
    return ((end_frame - start_frame) // get_frame_step(scene)) + 1


def describe_render_job(scene):
    start_frame, end_frame = get_render_frame_range(scene)
    frame_count = get_render_frame_count(scene)
    render_type = 'Animation' if scene.runpod_is_animation else 'Still frame'
    target_scene = selected_render_scene(scene)
    target_camera = selected_render_camera(scene)
    return {
        'render_type': render_type,
        'start_frame': start_frame,
        'end_frame': end_frame,
        'frame_count': frame_count,
        'frame_step': get_frame_step(scene),
        'engine': scene.runpod_engine,
        'quality_preset': scene.runpod_quality_preset,
        'samples': scene.runpod_samples,
        'resolution_pct': scene.runpod_resolution_pct,
        'format': scene.runpod_output_format,
        'scene': target_scene.name if target_scene else 'Current scene',
        'camera': target_camera.name if target_camera else 'Scene camera',
        'project': get_selected_project_label(scene),
    }


def calculate_progress_percent(scene):
    if STATE.phase == 'complete':
        return 100
    if STATE.phase == 'packaging':
        return 5
    if STATE.phase == 'uploading':
        return 12
    if STATE.phase == 'submitted':
        return 20
    if STATE.phase not in {'rendering', 'downloading'}:
        return 0
    if STATE.phase == 'downloading':
        return 95

    target_samples = max(scene.runpod_samples, 1)
    if STATE.is_animation:
        total_frames = ((STATE.end_frame - STATE.start_frame) // max(STATE.frame_step, 1)) + 1
        completed_frame_index = max(0, (STATE.frame_current - STATE.start_frame) // max(STATE.frame_step, 1))
        sample_pct = STATE.sample_current / target_samples
        pct = int(((completed_frame_index + sample_pct) / max(total_frames, 1)) * 100) if STATE.sample_current else int((completed_frame_index / max(total_frames, 1)) * 100)
    else:
        pct = int((STATE.sample_current / target_samples) * 100) if STATE.sample_current else 25

    return min(94, max(20, pct))


def check_job_status():
    if not STATE.job_id:
        return None

    scene = getattr(bpy.context, 'scene', None)
    elapsed = int(time.time() - STATE.job_start_time)
    mins, secs = divmod(elapsed, 60)
    STATE.elapsed = f"{mins:02d}:{secs:02d}"
    force_ui_redraw()

    if time.time() - STATE.last_api_check < 5.0:
        return 1.0

    STATE.last_api_check = time.time()
    status_endpoint = f"{get_server_url()}/api/job-status/{STATE.job_id}"

    try:
        log_verbose('Polling render status', job_id=STATE.job_id)
        req = urllib.request.Request(status_endpoint, headers=auth_headers())
        with urllib.request.urlopen(req) as response:
            data = json.loads(response.read().decode())
            status = data.get('status')
            log_verbose('Received render status', job_id=STATE.job_id, status=status)

        if status in ['IN_QUEUE', 'IN_PROGRESS', 'RUNNING', 'SUBMITTED']:
            if status == 'IN_QUEUE':
                set_status('Submitted: waiting for a render worker...', phase='submitted', flow_state='RENDERING')
            else:
                set_status('Rendering animation...' if STATE.is_animation else 'Rendering frame...', phase='rendering', flow_state='RENDERING')

            stream_data = data.get('stream', [])
            if stream_data and isinstance(stream_data, list):
                for item in reversed(stream_data):
                    payload = item
                    if isinstance(item, dict):
                        if 'update' in item:
                            payload = item['update']
                        elif 'output' in item:
                            payload = item['output']
                    if isinstance(payload, str):
                        try:
                            payload = json.loads(payload)
                        except Exception:
                            pass
                    if isinstance(payload, dict):
                        found_data = False
                        if 'current_frame' in payload:
                            STATE.frame_current = payload['current_frame']
                            found_data = True
                        if 'current_sample' in payload:
                            STATE.sample_current = payload['current_sample']
                            found_data = True
                        if found_data:
                            break

        elif status == 'COMPLETED':
            set_status('Complete: downloading output...', phase='downloading', flow_state='RENDERING')
            download_url = data.get('downloadUrl')
            if not download_url:
                STATE.error = 'Render completed but no download URL was returned.'
                set_status('Failed: no download URL was returned.', phase='failed', flow_state='FAILED')
                STATE.job_id = None
                return None

            if STATE.is_animation:
                output_dir = get_animation_output_dir()
                os.makedirs(output_dir, exist_ok=True)
                output_path = os.path.join(output_dir, f"animation_{STATE.job_id[:6]}.zip")
                log_verbose('Downloading completed animation', job_id=STATE.job_id, path=output_path)
                download_authenticated_file(download_url, output_path)
                STATE.last_output_kind = 'animation'
                STATE.last_output_path = output_path
                set_status('Complete: animation zip saved.', phase='complete', flow_state='COMPLETE')
            else:
                output_path = os.path.join(bpy.app.tempdir, f"cloud_render_final.{STATE.download_extension}")
                log_verbose('Downloading completed frame', job_id=STATE.job_id, path=output_path)
                download_authenticated_file(download_url, output_path)
                img = bpy.data.images.load(output_path)
                for window in bpy.context.window_manager.windows:
                    for area in window.screen.areas:
                        if area.type == 'IMAGE_EDITOR':
                            area.spaces.active.image = img
                STATE.last_output_kind = 'image'
                STATE.last_output_path = output_path
                set_status('Complete: still image downloaded.', phase='complete', flow_state='COMPLETE')

            STATE.job_id = None
            return None

        elif status == 'FAILED':
            raw_error = data.get('error') or data.get('message') or data.get('job', {}).get('error')
            STATE.error = sanitize_render_error(raw_error, 'Render failed while processing the scene.')
            log_verbose('Render failed', job_id=STATE.job_id, error=STATE.error)
            set_status('Failed: render processing did not finish.', phase='failed', flow_state='FAILED')
            STATE.job_id = None
            return None

        elif status == 'CANCELLED':
            STATE.error = 'The render was cancelled.'
            set_status('Cancelled: render job stopped.', phase='cancelled', flow_state='FAILED')
            STATE.job_id = None
            return None

        else:
            STATE.error = f"Unexpected job status: {status}"
            set_status('Failed: unexpected render status.', phase='failed', flow_state='FAILED')
            STATE.job_id = None
            return None

    except Exception as exc:
        log_verbose('Status check failed', error=exc)

    return 1.0


class RENDERSPHERE_AddonPreferences(bpy.types.AddonPreferences):
    bl_idname = __package__ if __package__ else __name__

    server_url: bpy.props.StringProperty(
        name='Server URL',
        description='RenderSphere service URL',
        default=DEFAULT_SERVER_URL,
    )
    api_key: bpy.props.StringProperty(
        name='Access Key',
        description='RenderSphere access key from your dashboard',
        default='',
        subtype='PASSWORD',
    )
    animation_output_dir: bpy.props.StringProperty(
        name='Animation Download Folder',
        description='Folder used for completed animation zip downloads',
        default='',
        subtype='DIR_PATH',
    )
    verbose_logging: bpy.props.BoolProperty(
        name='Verbose Logging',
        description='Print detailed RenderSphere extension activity to the Blender console',
        default=True,
    )

    def draw(self, context):
        layout = self.layout
        layout.label(text=f"RenderSphere Add-on v{ADDON_VERSION}")
        layout.label(text=f"Server: {DEFAULT_SERVER_URL}")
        layout.prop(self, 'api_key')
        layout.prop(self, 'animation_output_dir')
        layout.prop(self, 'verbose_logging')
        row = layout.row(align=True)
        row.operator('rendersphere.connect', icon='KEY_HLT')


class RENDERSPHERE_OT_test_connection(bpy.types.Operator):
    bl_idname = 'rendersphere.test_connection'
    bl_label = 'Test Connection'
    bl_options = {'REGISTER'}

    def execute(self, context):
        log_verbose('Testing account connection', context, server=get_server_url(context))
        if not get_api_key(context):
            STATE.error = 'Add your RenderSphere access key before testing.'
            set_status('Failed: access key is missing.', phase='failed', flow_state='FAILED', context=context)
            self.report({'ERROR'}, STATE.error)
            return {'CANCELLED'}

        try:
            req = urllib.request.Request(f"{get_server_url(context)}/api/auth/me", headers=auth_headers(context))
            with urllib.request.urlopen(req, timeout=15) as response:
                data = json.loads(response.read().decode())
                user = data.get('user', {})
                email = user.get('email', 'account')

            STATE.connected_account = email
            STATE.error = ''
            log_verbose('Connection test succeeded', context, account=email)
            set_status(f"Connected as {email}.", phase='connected', flow_state='SETUP', context=context)
            self.report({'INFO'}, f"Connected as {email}")
            return {'FINISHED'}
        except Exception as exc:
            STATE.error = describe_url_error(exc)
            log_verbose('Connection test failed', context, error=STATE.error)
            set_status('Failed: connection test did not succeed.', phase='failed', flow_state='FAILED', context=context)
            self.report({'ERROR'}, STATE.error)
            return {'CANCELLED'}


class RENDERSPHERE_OT_connect(bpy.types.Operator):
    bl_idname = 'rendersphere.connect'
    bl_label = 'Connect Account'
    bl_options = {'REGISTER'}

    def execute(self, context):
        prefs = get_addon_preferences(context)
        log_verbose('Connecting account', context, server=get_server_url(context))
        if not prefs:
            STATE.error = 'Could not find RenderSphere add-on preferences.'
            self.report({'ERROR'}, STATE.error)
            return {'CANCELLED'}

        if not get_api_key(context):
            STATE.error = 'Enter your RenderSphere access key.'
            set_status('Failed: access key is missing.', phase='failed', flow_state='FAILED', context=context)
            self.report({'ERROR'}, STATE.error)
            return {'CANCELLED'}

        try:
            req = urllib.request.Request(f"{get_server_url(context)}/api/auth/me", headers=auth_headers(context))
            with urllib.request.urlopen(req, timeout=15) as response:
                data = json.loads(response.read().decode())
                user = data.get('user', {})
                email = user.get('email', 'account')

            try:
                bpy.ops.wm.save_userpref()
            except Exception as exc:
                log_verbose('Could not save user preferences after connect', context, error=exc)

            try:
                fetch_projects(context)
            except Exception as exc:
                log_verbose('Project refresh after connect failed', context, error=exc)

            balance = user.get('starterBalanceUsd', 0)
            STATE.connected_account = f"{email} · ${balance} balance"
            STATE.error = ''
            log_verbose('Account connected', context, account=email)
            set_status(f"Connected as {email}.", phase='connected', flow_state='SETUP', context=context)
            self.report({'INFO'}, f"RenderSphere connected for {email}")
            return {'FINISHED'}
        except Exception as exc:
            STATE.error = describe_url_error(exc)
            log_verbose('Account connect failed', context, error=STATE.error)
            set_status('Failed: could not connect account.', phase='failed', flow_state='FAILED', context=context)
            self.report({'ERROR'}, STATE.error)
            return {'CANCELLED'}


class RENDERSPHERE_OT_clear_access_key(bpy.types.Operator):
    bl_idname = 'rendersphere.clear_access_key'
    bl_label = 'Sign Out'
    bl_options = {'REGISTER'}

    def execute(self, context):
        prefs = get_addon_preferences(context)
        if prefs:
            prefs.api_key = ''
            try:
                bpy.ops.wm.save_userpref()
            except Exception as exc:
                log_verbose('Could not save user preferences after sign out', context, error=exc)

        set_project_items([])
        STATE.connected_account = ''
        log_verbose('Access key cleared', context)
        reset_job_state(context=context)
        set_flow_state(context.scene, 'SETUP')
        self.report({'INFO'}, 'RenderSphere access key removed.')
        return {'FINISHED'}


class RENDERSPHERE_OT_refresh_projects(bpy.types.Operator):
    bl_idname = 'rendersphere.refresh_projects'
    bl_label = 'Refresh Projects'
    bl_options = {'REGISTER'}

    def execute(self, context):
        if not get_api_key(context):
            STATE.error = 'Connect your account before refreshing projects.'
            set_status('Failed: access key is missing.', phase='failed', flow_state='FAILED', context=context)
            self.report({'ERROR'}, STATE.error)
            return {'CANCELLED'}

        try:
            projects = fetch_projects(context)
            STATE.error = ''
            set_status(f"Projects refreshed: {len(projects)} available.", phase='connected', flow_state='SETUP', context=context)
            self.report({'INFO'}, f"Loaded {len(projects)} RenderSphere projects")
            return {'FINISHED'}
        except Exception as exc:
            STATE.error = describe_url_error(exc)
            log_verbose('Project refresh failed', context, error=STATE.error)
            set_status('Failed: could not refresh projects.', phase='failed', flow_state='FAILED', context=context)
            self.report({'ERROR'}, STATE.error)
            return {'CANCELLED'}


class RENDERSPHERE_OT_review_render(bpy.types.Operator):
    bl_idname = 'rendersphere.review_render'
    bl_label = 'Review Render'
    bl_options = {'REGISTER'}

    def execute(self, context):
        scene = context.scene
        if not get_api_key(context):
            STATE.error = 'Connect your RenderSphere account before reviewing a render.'
            set_status('Failed: account is not connected.', phase='failed', flow_state='FAILED', context=context)
            self.report({'ERROR'}, STATE.error)
            return {'CANCELLED'}

        start_frame, end_frame = get_render_frame_range(scene)
        if end_frame < start_frame:
            STATE.error = 'End frame must be greater than or equal to start frame.'
            set_status('Failed: frame range is invalid.', phase='failed', flow_state='FAILED', context=context)
            self.report({'ERROR'}, STATE.error)
            return {'CANCELLED'}

        if not selected_render_camera(scene):
            STATE.error = 'Choose a camera or assign a camera to the selected scene.'
            set_status('Failed: camera is missing.', phase='failed', flow_state='FAILED', context=context)
            self.report({'ERROR'}, STATE.error)
            return {'CANCELLED'}

        STATE.error = ''
        set_status('Review the render settings before submitting.', phase='idle', flow_state='REVIEW', context=context)
        return {'FINISHED'}


class RENDERSPHERE_OT_edit_setup(bpy.types.Operator):
    bl_idname = 'rendersphere.edit_setup'
    bl_label = 'Edit Setup'
    bl_options = {'REGISTER'}

    def execute(self, context):
        if is_busy():
            self.report({'WARNING'}, 'A render is active. Cancel it before changing setup.')
            return {'CANCELLED'}
        set_status('Ready to edit render setup.', phase='idle', flow_state='SETUP', context=context)
        return {'FINISHED'}


class RENDERSPHERE_OT_open_last_output(bpy.types.Operator):
    bl_idname = 'rendersphere.open_last_output'
    bl_label = 'Open Output'
    bl_options = {'REGISTER'}

    def execute(self, context):
        if not STATE.last_output_path or not os.path.exists(STATE.last_output_path):
            self.report({'ERROR'}, 'No downloaded output file is available.')
            return {'CANCELLED'}

        try:
            os.startfile(STATE.last_output_path)
            return {'FINISHED'}
        except Exception as exc:
            self.report({'ERROR'}, f"Could not open output: {exc}")
            return {'CANCELLED'}


def _make_auth_headers(api_key, content_type=None):
    """Build auth headers without touching bpy.context (not thread-safe)."""
    headers = {}
    if api_key:
        headers['Authorization'] = f"Bearer {api_key}"
    if content_type:
        headers['Content-Type'] = content_type
    return headers


def _run_upload_bg(server_url, api_key, temp_path, file_size, trigger_payload):
    """Run upload + trigger in a background thread so Blender stays responsive."""
    global _bg_upload
    auth = lambda ct=None: _make_auth_headers(api_key, ct)
    try:
        _bg_upload['status'] = 'Requesting upload link...'
        api_endpoint = f"{server_url}/api/get-upload-url"
        upload_payload = json.dumps({
            'fileName': 'rendersphere_payload.blend',
            'fileSizeBytes': file_size,
        }).encode('utf-8')

        req = urllib.request.Request(api_endpoint, data=upload_payload, headers=auth('application/json'))
        with urllib.request.urlopen(req) as response:
            res_data = json.loads(response.read().decode())
            _bg_upload['upload_url'] = res_data.get('uploadUrl')
            _bg_upload['file_key'] = res_data.get('key')
        if not _bg_upload['upload_url'] or not _bg_upload['file_key']:
            raise RuntimeError('Upload URL response was missing uploadUrl or key.')

        _bg_upload['status'] = 'Uploading to cloud storage...'
        upload_res = http_put_file(_bg_upload['upload_url'], temp_path, file_size)
        upload_status = upload_res.status
        upload_res.read()
        if upload_status not in (200, 201):
            raise RuntimeError(f"Upload failed with status {upload_status}.")

        _bg_upload['status'] = 'Triggering render...'
        _bg_upload['progress_pct'] = 100
        trigger_payload['fileKey'] = _bg_upload['file_key']
        trigger_bytes = json.dumps(trigger_payload).encode('utf-8')
        trigger_req = urllib.request.Request(
            f"{server_url}/api/trigger-render",
            data=trigger_bytes,
            headers=auth('application/json')
        )
        with urllib.request.urlopen(trigger_req) as tr:
            job_data = json.loads(tr.read().decode())
            _bg_upload['job_id'] = job_data.get('jobId')
        if not _bg_upload['job_id']:
            raise RuntimeError('Render trigger did not return a jobId.')

        _bg_upload['success'] = True
        _bg_upload['phase'] = 'submitted'
        _bg_upload['status'] = 'Render submitted! Waiting for worker...'
    except Exception as exc:
        _bg_upload['error'] = describe_url_error(exc)
        _bg_upload['phase'] = 'failed'
        _bg_upload['status'] = f"Failed: {_bg_upload['error']}"
        _bg_upload['success'] = False
        log_verbose('Background upload failed', None, error=_bg_upload['error'])
    finally:
        _bg_upload['done'] = True
        _bg_upload['running'] = False


def _poll_upload():
    """Timer callback: updates Blender UI from background thread progress."""
    global _bg_upload
    if _bg_upload['running']:
        STATE.status = _bg_upload['status']
        STATE.phase = _bg_upload['phase']
        force_ui_redraw()
        return 0.5

    if _bg_upload['done']:
        # Clean up temp file
        if _bg_upload.get('temp_path'):
            remove_temp_payload(_bg_upload['temp_path'])
            _bg_upload['temp_path'] = None

        if _bg_upload['success'] and _bg_upload['job_id']:
            STATE.job_id = _bg_upload['job_id']
            STATE.job_start_time = time.time()
            STATE.last_api_check = time.time() - 5.0
            set_status('Render submitted! Waiting for worker...', phase='submitted', flow_state='RENDERING')
            bpy.app.timers.register(check_job_status, first_interval=1.0)
        else:
            STATE.error = _bg_upload['error']
            STATE.phase = 'failed'
            set_status(f"Failed: {_bg_upload['error']}", phase='failed', flow_state='FAILED')
        _bg_upload['done'] = False
        global _bg_upload_lock
        _bg_upload_lock = False
        return None

    return None


class RENDER_OT_cloud_upload(bpy.types.Operator):
    bl_idname = 'render.cloud_upload'
    bl_label = 'Submit Render'
    bl_options = {'REGISTER', 'UNDO'}

    ignore_missing: bpy.props.BoolProperty(default=False, options={'HIDDEN'})
    missing_summary: bpy.props.StringProperty(default='', options={'HIDDEN'})
    spend_alert: bpy.props.StringProperty(
        name='Spend Alert',
        description='Email me if the final cost exceeds this amount (optional)',
        default='',
    )

    def invoke(self, context, event):
        missing_files = get_missing_external_files()
        self.missing_summary = ', '.join(missing_files[:5])
        if len(missing_files) > 5:
            self.missing_summary += f" and {len(missing_files) - 5} more"
        return context.window_manager.invoke_props_dialog(self, width=480)

    def draw(self, context):
        layout = self.layout
        scene = context.scene
        summary = describe_render_job(scene)

        if self.missing_summary:
            layout.label(text='Warning: Missing External Files', icon='ERROR')
            layout.label(text=self.missing_summary)
            layout.label(text='The final render might have missing textures.')
            layout.prop(self, 'ignore_missing', text='Proceed with missing files')
            layout.separator()

        layout.label(text='Submit RenderSphere Job', icon='RENDER_STILL')
        layout.label(text=f"Type: {summary['render_type']}")
        layout.label(text=f"Frames: {summary['start_frame']} - {summary['end_frame']} ({summary['frame_count']} total)")
        layout.label(text=f"Scene: {summary['scene']}")
        layout.label(text=f"Camera: {summary['camera']}")
        layout.label(text=f"Quality: {summary['quality_preset']}")
        layout.label(text=f"Samples: {summary['samples']}")
        layout.label(text=f"Resolution: {summary['resolution_pct']}%")
        layout.label(text=f"Format: {summary['format']}")
        layout.separator()
        # Show cost estimate in the dialog
        est_secs, est_cost = estimate_cost_usd(context.scene)
        layout.label(text=f"Estimated cost: ${est_cost:.4f} (~{est_secs} GPU sec)", icon='INFO')
        layout.separator()
        layout.prop(self, 'spend_alert', text='Spend alert ($)')
        layout.label(text='This will package, upload, and use render credits once started.')

    def execute(self, context):
        scene = context.scene
        server_url = get_server_url(context)
        log_verbose('Preparing render submission', context, server=server_url)

        if is_busy():
            STATE.error = 'A render job is already active.'
            self.report({'ERROR'}, STATE.error)
            return {'CANCELLED'}

        if not get_api_key(context):
            STATE.error = 'Add your RenderSphere access key in the add-on preferences.'
            set_status('Failed: account is not connected.', phase='failed', flow_state='FAILED', context=context)
            return {'CANCELLED'}

        missing_files = get_missing_external_files()
        if missing_files and not self.ignore_missing:
            STATE.error = 'Missing external files must be acknowledged before rendering.'
            log_verbose('Render submission blocked: missing external files', context, missing_count=len(missing_files))
            set_status('Failed: missing external files need confirmation.', phase='failed', flow_state='FAILED', context=context)
            return {'CANCELLED'}

        start_frame, end_frame = get_render_frame_range(scene)
        target_scene = selected_render_scene(scene)
        target_camera = selected_render_camera(scene)

        if end_frame < start_frame:
            STATE.error = 'End frame must be greater than or equal to start frame.'
            set_status('Failed: frame range is invalid.', phase='failed', flow_state='FAILED', context=context)
            return {'CANCELLED'}

        if not target_camera:
            STATE.error = 'Choose a camera or assign a camera to the selected scene.'
            set_status('Failed: camera is missing.', phase='failed', flow_state='FAILED', context=context)
            return {'CANCELLED'}

        STATE.start_frame = start_frame
        STATE.end_frame = end_frame if scene.runpod_is_animation else start_frame
        STATE.frame_step = get_frame_step(scene)
        STATE.download_extension = OUTPUT_EXTENSIONS.get(scene.runpod_output_format, 'png')
        STATE.frame_current = start_frame
        STATE.sample_current = 0
        STATE.error = ''
        STATE.last_output_path = ''
        STATE.last_output_kind = ''
        STATE.is_animation = scene.runpod_is_animation

        set_status('Packaging: packing external files and saving payload...', phase='packaging', flow_state='SUBMITTING', context=context)
        temp_path = os.path.join(bpy.app.tempdir, 'rendersphere_payload.blend')

        try:
            try:
                log_verbose('Packing external files', context)
                bpy.ops.file.pack_all()
            except RuntimeError as exc:
                log_verbose('Skipped packing some files', context, error=exc)

            log_verbose('Saving temporary payload', context, path=temp_path)
            bpy.ops.wm.save_as_mainfile(filepath=temp_path, copy=True)
            file_size = os.path.getsize(temp_path)
            max_upload_bytes = get_service_max_upload_bytes(context)
            log_verbose('Temporary payload ready', context, file_size=file_size, max_upload_bytes=max_upload_bytes)

            if file_size > max_upload_bytes:
                STATE.error = f"Packed file is larger than {max_upload_bytes // (1024 * 1024)} MB."
                set_status('Failed: packed file is too large.', phase='failed', flow_state='FAILED', context=context)
                return {'CANCELLED'}

            project_id = get_selected_project_id(scene)

            # Check for spend alert from dialog
            spend_alert_val = getattr(self, 'spend_alert', '')

            trigger_payload = {
                'fileKey': '',  # filled by background thread after upload
                'engine': scene.runpod_engine,
                'samples': scene.runpod_samples,
                'isAnimation': scene.runpod_is_animation,
                'startFrame': start_frame,
                'endFrame': end_frame,
                'outputFormat': scene.runpod_output_format,
                'resolutionPct': scene.runpod_resolution_pct,
                'denoiser': scene.runpod_denoiser,
                'noiseThreshold': scene.runpod_noise_threshold,
                'scene': target_scene.name if target_scene else '',
                'camera': target_camera.name if target_camera else '',
                'projectId': project_id,
                'advancedMode': scene.runpod_advanced_mode,
                'spendAlertUsd': spend_alert_val,
            }

            if scene.runpod_advanced_mode:
                trigger_payload.update({
                    'gpuDeviceType': scene.runpod_gpu_device_type,
                    'allowCpuFallback': scene.runpod_allow_cpu_fallback,
                    'transparentFilm': scene.runpod_transparent_film,
                    'usePersistentData': scene.runpod_use_persistent_data,
                    'frameStep': get_frame_step(scene),
                    'viewTransform': scene.runpod_view_transform,
                    'look': scene.runpod_look,
                    'exposure': scene.runpod_exposure,
                    'gamma': scene.runpod_gamma,
                    'maxBounces': scene.runpod_max_bounces,
                    'diffuseBounces': scene.runpod_diffuse_bounces,
                    'glossyBounces': scene.runpod_glossy_bounces,
                    'transmissionBounces': scene.runpod_transmission_bounces,
                    'transparentBounces': scene.runpod_transparent_bounces,
                    'causticsReflective': scene.runpod_caustics_reflective,
                    'causticsRefractive': scene.runpod_caustics_refractive,
                    'useSimplify': scene.runpod_use_simplify,
                    'simplifySubdivisions': scene.runpod_simplify_subdivisions,
                    'simplifyTextureLimit': scene.runpod_simplify_texture_limit,
                })

            # Start background upload + trigger so Blender stays responsive
            global _bg_upload, _bg_upload_lock
            if _bg_upload_lock:
                STATE.error = 'An upload is already in progress.'
                set_status('Failed: upload already in progress.', phase='failed', flow_state='FAILED', context=context)
                return {'CANCELLED'}
            _bg_upload_lock = True

            _bg_upload['running'] = True
            _bg_upload['done'] = False
            _bg_upload['success'] = False
            _bg_upload['phase'] = 'uploading'
            _bg_upload['progress_pct'] = 0
            _bg_upload['status'] = 'Starting upload...'
            _bg_upload['temp_path'] = temp_path
            _bg_upload['file_size'] = file_size

            import threading
            thread = threading.Thread(
                target=_run_upload_bg,
                args=(server_url, get_api_key(context), temp_path, file_size, trigger_payload),
                daemon=True
            )
            thread.start()
            bpy.app.timers.register(_poll_upload, first_interval=0.5)

            set_status('Uploading to cloud storage...', phase='uploading', flow_state='SUBMITTING', context=context)

            # Don't block — the background thread + timer handle the rest
            return {'FINISHED'}

        finally:
            self.ignore_missing = False

        return {'FINISHED'}


class RENDER_OT_cancel_job(bpy.types.Operator):
    bl_idname = 'render.cancel_job'
    bl_label = 'Cancel Render'
    bl_options = {'REGISTER'}

    def execute(self, context):
        if not STATE.job_id:
            log_verbose('Cancel requested without an active job', context)
            reset_job_state(context=context)
            return {'CANCELLED'}

        job_id = STATE.job_id
        log_verbose('Cancelling render job', context, job_id=job_id)
        set_status('Cancelling: asking RenderSphere to stop the job...', phase='cancelling', flow_state='RENDERING', context=context)

        try:
            payload = json.dumps({'jobId': job_id}).encode('utf-8')
            req = urllib.request.Request(
                f"{get_server_url(context)}/api/cancel-job",
                data=payload,
                headers=auth_headers(context, 'application/json'),
                method='POST',
            )
            with urllib.request.urlopen(req) as response:
                response.read()
            log_verbose('Cancel request completed', context, job_id=job_id)
        except Exception as exc:
            log_verbose('Cancel request failed', context, error=exc)
        finally:
            STATE.job_id = None
            STATE.error = 'The render was cancelled.'
            set_status('Cancelled: render job stopped.', phase='cancelled', flow_state='FAILED', context=context)

        return {'FINISHED'}


def draw_flow_banner(layout, context):
    scene = context.scene
    flow = getattr(scene, 'rendersphere_flow_state', 'SETUP')
    pct = calculate_progress_percent(scene)
    icon = 'ERROR' if flow == 'FAILED' else ('CHECKMARK' if flow == 'COMPLETE' else ('TIME' if flow in {'SUBMITTING', 'RENDERING'} else 'RIGHTARROW'))

    box = layout.box()
    box.label(text=f"RenderSphere · {dict((item[0], item[1]) for item in FLOW_ITEMS).get(flow, 'Setup')}", icon=icon)
    box.label(text=STATE.status)
    if flow in {'SUBMITTING', 'RENDERING'}:
        box.label(text=f"Progress: {pct}%")
        meter_blocks = 12
        filled_blocks = int((pct / 100) * meter_blocks)
        box.label(text='[' + '#' * filled_blocks + '-' * (meter_blocks - filled_blocks) + ']')
    if STATE.error and flow == 'FAILED':
        box.label(text=STATE.error, icon='ERROR')


def draw_account_section(layout, context):
    prefs = get_addon_preferences(context)
    box = layout.box()
    box.label(text='Account', icon='KEY_HLT')

    if prefs:
        box.prop(prefs, 'api_key', text='Access Key')

    if get_api_key(context):
        if STATE.connected_account:
            box.label(text=STATE.connected_account, icon='CHECKMARK')
        else:
            box.operator('rendersphere.connect', text='Connect', icon='KEY_HLT')
            box.label(text='Access key saved. Click Connect to verify.', icon='INFO')
        box.operator('rendersphere.clear_access_key', text='Sign Out', icon='UNLINKED')
    else:
        box.label(text='Paste an access key from your RenderSphere dashboard.')
        box.operator('rendersphere.connect', text='Connect', icon='KEY_HLT')


def draw_project_section(layout, context):
    scene = context.scene
    box = layout.box()
    box.label(text='Project', icon='FILE_FOLDER')
    row = box.row(align=True)
    row.prop(scene, 'runpod_project', text='')
    row.operator('rendersphere.refresh_projects', text='', icon='FILE_REFRESH')
    if PROJECT_LAST_REFRESH:
        box.label(text=f"Projects loaded: {max(0, len(PROJECT_ITEMS) - 1)}")
    else:
        box.label(text='Optional. Refresh after connecting to load dashboard projects.')


def draw_scene_section(layout, context):
    scene = context.scene
    box = layout.box()
    box.label(text='Scene & Camera', icon='SCENE_DATA')
    box.prop(scene, 'runpod_scene', text='Scene')
    box.prop(scene, 'runpod_camera', text='Camera')
    box.prop(scene, 'runpod_render_type', text='Type')

    if scene.runpod_is_animation:
        box.prop(scene, 'runpod_use_scene_frames', text='Use Scene Frame Range')
        row = box.row(align=True)
        row.enabled = not scene.runpod_use_scene_frames
        row.prop(scene, 'runpod_frame_start', text='Start')
        row.prop(scene, 'runpod_frame_end', text='End')
        if should_show_advanced_controls(scene):
            box.prop(scene, 'runpod_frame_step', text='Frame Step')
        prefs = get_addon_preferences(context)
        if prefs:
            box.prop(prefs, 'animation_output_dir', text='Zip Save Folder')
    else:
        target_scene = selected_render_scene(scene)
        box.label(text=f"Still frame: {target_scene.frame_current if target_scene else scene.frame_current}")


def draw_output_quality_section(layout, context):
    scene = context.scene
    box = layout.box()
    box.label(text='Output & Quality', icon='OUTPUT')
    box.prop(scene, 'runpod_output_format', text='Format')
    box.prop(scene, 'runpod_quality_preset', text='Quality')
    box.prop(scene, 'runpod_advanced_mode', text='Show Advanced')

    if should_show_quality_controls(scene):
        custom = layout.box()
        custom.label(text='Custom Quality', icon='SETTINGS')
        custom.prop(scene, 'runpod_engine', text='Engine')
        custom.prop(scene, 'runpod_samples', text='Samples')
        custom.prop(scene, 'runpod_resolution_pct', text='Resolution %')
        if scene.runpod_engine == 'CYCLES':
            custom.prop(scene, 'runpod_denoiser', text='Denoiser')
            custom.prop(scene, 'runpod_noise_threshold', text='Noise Threshold')
    else:
        values = QUALITY_PRESETS.get(scene.runpod_quality_preset, QUALITY_PRESETS['BALANCED'])
        box.label(text=f"Preset sends {values['samples']} samples at {values['resolution_pct']}% resolution.")


def draw_advanced_section(layout, context):
    scene = context.scene
    if not should_show_advanced_controls(scene):
        return

    advanced = layout.box()
    advanced.label(text='Advanced Render Settings', icon='PREFERENCES')
    advanced.prop(scene, 'runpod_gpu_device_type', text='GPU Backend')
    advanced.prop(scene, 'runpod_allow_cpu_fallback', text='Allow CPU Fallback')
    advanced.prop(scene, 'runpod_transparent_film', text='Transparent Film')

    if scene.runpod_engine == 'CYCLES':
        cycles_box = layout.box()
        cycles_box.label(text='Cycles', icon='MOD_PHYSICS')
        cycles_box.prop(scene, 'runpod_use_persistent_data', text='Persistent Data')
        cycles_box.prop(scene, 'runpod_max_bounces', text='Max Bounces')
        row = cycles_box.row(align=True)
        row.prop(scene, 'runpod_diffuse_bounces', text='Diffuse')
        row.prop(scene, 'runpod_glossy_bounces', text='Glossy')
        row = cycles_box.row(align=True)
        row.prop(scene, 'runpod_transmission_bounces', text='Transmission')
        row.prop(scene, 'runpod_transparent_bounces', text='Transparent')
        cycles_box.prop(scene, 'runpod_caustics_reflective', text='Reflective Caustics')
        cycles_box.prop(scene, 'runpod_caustics_refractive', text='Refractive Caustics')

    color_box = layout.box()
    color_box.label(text='Color & Film', icon='IMAGE_DATA')
    color_box.prop(scene, 'runpod_view_transform', text='View Transform')
    color_box.prop(scene, 'runpod_look', text='Look')
    row = color_box.row(align=True)
    row.prop(scene, 'runpod_exposure', text='Exposure')
    row.prop(scene, 'runpod_gamma', text='Gamma')

    perf_box = layout.box()
    perf_box.label(text='Performance', icon='MEMORY')
    perf_box.prop(scene, 'runpod_use_simplify', text='Use Simplify')
    if scene.runpod_use_simplify:
        perf_box.prop(scene, 'runpod_simplify_subdivisions', text='Max Subdivision')
        perf_box.prop(scene, 'runpod_simplify_texture_limit', text='Texture Limit')


RENDER_PRICE_PER_SECOND_USD = 0.00028
BASE_SECONDS_PER_FRAME = 60

def estimate_cost_usd(scene):
    """Replicate the backend cost estimate locally so the user sees it before submitting."""
    frame_count = 1
    if scene.runpod_is_animation:
        start = scene.runpod_frame_start if not scene.runpod_use_scene_frames else scene.frame_start
        end = scene.runpod_frame_end if not scene.runpod_use_scene_frames else scene.frame_end
        frame_count = max(1, end - start + 1)
    samples = scene.runpod_samples
    res_pct = scene.runpod_resolution_pct
    engine = scene.runpod_engine
    denoiser = scene.runpod_denoiser
    fmt = scene.runpod_output_format
    advanced = scene.runpod_advanced_mode

    samples_factor = max(0.1, samples / 256)
    res_factor = max(0.01, (res_pct / 100) ** 2)
    engine_factor = 1.0 if engine == 'CYCLES' else 0.45
    denoiser_factor = 1.08 if denoiser != 'NONE' else 1.0
    output_factor = 1.15 if fmt.startswith('OPEN_EXR') else 1.0
    complexity = 1.1 if advanced else 1.0

    est_secs = max(1, int(BASE_SECONDS_PER_FRAME * frame_count * samples_factor * res_factor * engine_factor * denoiser_factor * output_factor * complexity))
    est_cost = est_secs * RENDER_PRICE_PER_SECOND_USD
    return est_secs, est_cost


def draw_review_section(layout, context):
    scene = context.scene
    summary = describe_render_job(scene)
    missing_files = get_missing_external_files()
    est_secs, est_cost = estimate_cost_usd(scene)

    box = layout.box()
    box.label(text='Review', icon='RENDER_STILL')
    box.label(text=f"Type: {summary['render_type']}")
    box.label(text=f"Frames: {summary['start_frame']} - {summary['end_frame']} ({summary['frame_count']} total)")
    box.label(text=f"Scene: {summary['scene']}")
    box.label(text=f"Camera: {summary['camera']}")
    box.label(text=f"Project: {summary['project']}")
    box.label(text=f"Engine: {summary['engine']}")
    box.label(text=f"Quality: {summary['quality_preset']} · {summary['samples']} samples · {summary['resolution_pct']}%")
    box.label(text=f"Format: {summary['format']}")
    if scene.runpod_advanced_mode:
        box.label(text=f"Advanced: On · GPU {scene.runpod_gpu_device_type} · frame step {summary['frame_step']}")

    # Cost estimate
    cost_box = layout.box()
    cost_box.label(text='Cost Estimate', icon='INFO')
    cost_box.label(text=f"~{est_secs} GPU seconds (${est_cost:.4f})")
    cost_box.label(text=f"~${est_cost:.2f} total (reserves ${max(0.25, est_cost * 2):.2f})")

    if missing_files:
        warning = layout.box()
        warning.label(text='Missing external files', icon='ERROR')
        warning.label(text=', '.join(missing_files[:4]))
        if len(missing_files) > 4:
            warning.label(text=f"and {len(missing_files) - 4} more")
        warning.label(text='The submit dialog must acknowledge this before upload.')

    row = box.row(align=True)
    edit_row = row.row(align=True)
    edit_row.enabled = not is_busy()
    edit_row.operator('rendersphere.edit_setup', text='Edit Setup', icon='PREFERENCES')
    submit_row = row.row(align=True)
    submit_row.enabled = can_submit_render(context)
    submit_row.operator('render.cloud_upload', text='Submit Render', icon='WORLD')

    if not get_api_key(context):
        box.label(text='Connect your account before submitting.', icon='ERROR')
    elif is_busy():
        box.label(text='A render is already active.', icon='TIME')


def draw_progress_section(layout, context):
    if getattr(context.scene, 'rendersphere_flow_state', 'SETUP') not in {'SUBMITTING', 'RENDERING', 'COMPLETE', 'FAILED'}:
        return

    box = layout.box()
    box.label(text='Render Status', icon='TIME')

    # Upload progress (background thread)
    if _bg_upload['running'] or _bg_upload['phase'] == 'uploading':
        box.label(text=_bg_upload['status'] or 'Uploading...', icon='NETWORK_DRIVE')
        pct = _bg_upload['progress_pct']
        if pct > 0:
            row = box.row()
            row.progress(factor=pct / 100.0, type='BAR')
            row.label(text=f"{pct}%")

    if STATE.job_id:
        box.label(text=f"Job: {STATE.job_id[:8]}")
        box.label(text=f"Elapsed: {STATE.elapsed}")
        if STATE.frame_current:
            box.label(text=f"Frame: {STATE.frame_current}")
        if STATE.sample_current:
            box.label(text=f"Sample: {STATE.sample_current}/{context.scene.runpod_samples}")
        box.operator('render.cancel_job', text='Cancel Render', icon='CANCEL')
    elif STATE.phase == 'complete':
        box.label(text='Output downloaded successfully.', icon='CHECKMARK')
        if STATE.last_output_path:
            box.label(text=STATE.last_output_path)
            box.operator('rendersphere.open_last_output', text='Open Output', icon='FILE_TICK')
        box.operator('rendersphere.edit_setup', text='Start Another Render', icon='PLUS')
    elif STATE.phase in {'failed', 'cancelled'}:
        box.label(text=STATE.error or STATE.status, icon='ERROR')
        box.operator('rendersphere.edit_setup', text='Back to Setup', icon='PREFERENCES')


class RENDER_PT_main_panel(bpy.types.Panel):
    bl_label = 'RenderSphere Render'
    bl_idname = 'RENDER_PT_main_panel'
    bl_space_type = 'VIEW_3D'
    bl_region_type = 'UI'
    bl_category = 'RenderSphere'

    def draw(self, context):
        layout = self.layout
        scene = context.scene
        flow = getattr(scene, 'rendersphere_flow_state', 'SETUP')

        draw_flow_banner(layout, context)
        layout.separator()

        if flow == 'REVIEW':
            draw_review_section(layout, context)
        elif flow in {'SUBMITTING', 'RENDERING', 'COMPLETE', 'FAILED'}:
            draw_progress_section(layout, context)
            if flow == 'FAILED':
                layout.separator()
                draw_account_section(layout, context)
        else:
            draw_account_section(layout, context)
            draw_project_section(layout, context)
            draw_scene_section(layout, context)
            draw_output_quality_section(layout, context)
            draw_advanced_section(layout, context)
            layout.separator()
            # Live cost estimate
            est_secs, est_cost = estimate_cost_usd(context.scene)
            cost_box = layout.box()
            cost_box.label(text=f"Est. cost: ${est_cost:.4f} (~{est_secs}s GPU)", icon='INFO')
            layout.separator()
            row = layout.row()
            row.enabled = not is_busy()
            row.operator('rendersphere.review_render', text='Review & Submit', icon='CHECKMARK')


classes = (
    RENDERSPHERE_AddonPreferences,
    RENDERSPHERE_OT_test_connection,
    RENDERSPHERE_OT_connect,
    RENDERSPHERE_OT_clear_access_key,
    RENDERSPHERE_OT_refresh_projects,
    RENDERSPHERE_OT_review_render,
    RENDERSPHERE_OT_edit_setup,
    RENDERSPHERE_OT_open_last_output,
    RENDER_OT_cloud_upload,
    RENDER_OT_cancel_job,
    RENDER_PT_main_panel,
)


def register():
    for cls in classes:
        bpy.utils.register_class(cls)

    bpy.types.Scene.runpod_engine = bpy.props.EnumProperty(
        name='Engine',
        items=[('CYCLES', 'Cycles', ''), ('BLENDER_EEVEE_NEXT', 'Eevee', '')],
        default='CYCLES',
    )
    bpy.types.Scene.runpod_quality_preset = bpy.props.EnumProperty(
        name='Quality Preset',
        description='Choose a simple quality target or Custom for detailed controls',
        items=QUALITY_PRESET_ITEMS,
        default='BALANCED',
        update=apply_quality_preset,
    )
    bpy.types.Scene.runpod_samples = bpy.props.IntProperty(
        name='Samples',
        description='Ray-tracing samples per pixel',
        default=128,
        min=1,
        max=8192,
    )
    bpy.types.Scene.runpod_render_type = bpy.props.EnumProperty(
        name='Render Type',
        items=RENDER_TYPE_ITEMS,
        default='STILL',
        update=sync_render_type,
    )
    bpy.types.Scene.runpod_is_animation = bpy.props.BoolProperty(
        name='Render Animation',
        description='Renders a sequence of frames and returns a .zip file',
        default=False,
    )
    bpy.types.Scene.runpod_frame_start = bpy.props.IntProperty(
        name='Start',
        default=1,
        min=0,
    )
    bpy.types.Scene.runpod_frame_end = bpy.props.IntProperty(
        name='End',
        default=250,
        min=1,
    )
    bpy.types.Scene.runpod_output_format = bpy.props.EnumProperty(
        name='Format',
        items=[
            ('PNG', 'PNG', ''),
            ('JPEG', 'JPEG', ''),
            ('OPEN_EXR', 'OpenEXR', ''),
            ('OPEN_EXR_MULTILAYER', 'Multilayer OpenEXR', ''),
        ],
        default='PNG',
    )
    bpy.types.Scene.runpod_resolution_pct = bpy.props.IntProperty(
        name='Resolution %',
        description='Resolution scale percentage',
        default=100,
        min=1,
        max=200,
    )
    bpy.types.Scene.runpod_use_scene_frames = bpy.props.BoolProperty(
        name='Use Scene Frame Range',
        description='Read start and end from the scene frame range when submitting the job',
        default=False,
    )
    bpy.types.Scene.runpod_denoiser = bpy.props.EnumProperty(
        name='Denoiser',
        items=[
            ('NONE', 'None', ''),
            ('OPTIX', 'OptiX', ''),
            ('OPENIMAGEDENOISE', 'OpenImageDenoise', ''),
        ],
        default='OPENIMAGEDENOISE',
    )
    bpy.types.Scene.runpod_noise_threshold = bpy.props.FloatProperty(
        name='Noise Threshold',
        description='Cycles adaptive sampling threshold. 0 disables adaptive sampling.',
        default=0.02,
        min=0.0,
        max=1.0,
    )
    bpy.types.Scene.runpod_advanced_mode = bpy.props.BoolProperty(
        name='Show Advanced',
        description='Show power-user render controls and send them with this job',
        default=False,
    )
    bpy.types.Scene.runpod_gpu_device_type = bpy.props.EnumProperty(
        name='GPU Backend',
        description='Preferred GPU backend for Cycles on the render worker',
        items=GPU_BACKEND_ITEMS,
        default='AUTO',
    )
    bpy.types.Scene.runpod_allow_cpu_fallback = bpy.props.BoolProperty(
        name='Allow CPU Fallback',
        description='Allow CPU rendering if GPU setup fails. Slower, but useful for diagnostics.',
        default=False,
    )
    bpy.types.Scene.runpod_frame_step = bpy.props.IntProperty(
        name='Frame Step',
        description='Render every Nth frame for animation jobs',
        default=1,
        min=1,
        max=1000,
    )
    bpy.types.Scene.runpod_transparent_film = bpy.props.BoolProperty(
        name='Transparent Film',
        description='Render with transparent film/background when supported',
        default=False,
    )
    bpy.types.Scene.runpod_use_persistent_data = bpy.props.BoolProperty(
        name='Persistent Data',
        description='Keep render data in memory between frames for animation performance',
        default=True,
    )
    bpy.types.Scene.runpod_view_transform = bpy.props.StringProperty(
        name='View Transform',
        description='Optional color management view transform. Leave empty to keep scene settings.',
        default='',
    )
    bpy.types.Scene.runpod_look = bpy.props.StringProperty(
        name='Look',
        description='Optional color management look. Leave empty to keep scene settings.',
        default='',
    )
    bpy.types.Scene.runpod_exposure = bpy.props.FloatProperty(
        name='Exposure',
        description='Color management exposure override',
        default=0.0,
        min=-10.0,
        max=10.0,
    )
    bpy.types.Scene.runpod_gamma = bpy.props.FloatProperty(
        name='Gamma',
        description='Color management gamma override',
        default=1.0,
        min=0.01,
        max=5.0,
    )
    bpy.types.Scene.runpod_max_bounces = bpy.props.IntProperty(
        name='Max Bounces',
        description='Cycles maximum light bounces',
        default=12,
        min=0,
        max=128,
    )
    bpy.types.Scene.runpod_diffuse_bounces = bpy.props.IntProperty(
        name='Diffuse Bounces',
        default=4,
        min=0,
        max=128,
    )
    bpy.types.Scene.runpod_glossy_bounces = bpy.props.IntProperty(
        name='Glossy Bounces',
        default=4,
        min=0,
        max=128,
    )
    bpy.types.Scene.runpod_transmission_bounces = bpy.props.IntProperty(
        name='Transmission Bounces',
        default=12,
        min=0,
        max=128,
    )
    bpy.types.Scene.runpod_transparent_bounces = bpy.props.IntProperty(
        name='Transparent Bounces',
        default=8,
        min=0,
        max=128,
    )
    bpy.types.Scene.runpod_caustics_reflective = bpy.props.BoolProperty(
        name='Reflective Caustics',
        default=True,
    )
    bpy.types.Scene.runpod_caustics_refractive = bpy.props.BoolProperty(
        name='Refractive Caustics',
        default=True,
    )
    bpy.types.Scene.runpod_use_simplify = bpy.props.BoolProperty(
        name='Use Simplify',
        description='Enable Blender simplify settings on the render worker',
        default=False,
    )
    bpy.types.Scene.runpod_simplify_subdivisions = bpy.props.IntProperty(
        name='Max Subdivision',
        default=2,
        min=0,
        max=12,
    )
    bpy.types.Scene.runpod_simplify_texture_limit = bpy.props.EnumProperty(
        name='Texture Limit',
        description='Texture limit applied when simplify is enabled',
        items=[
            ('OFF', 'Off', ''),
            ('128', '128 px', ''),
            ('256', '256 px', ''),
            ('512', '512 px', ''),
            ('1024', '1024 px', ''),
            ('2048', '2048 px', ''),
            ('4096', '4096 px', ''),
        ],
        default='OFF',
    )
    bpy.types.Scene.runpod_scene = bpy.props.PointerProperty(
        name='Scene',
        type=bpy.types.Scene,
        description='Scene to render. Empty means the current scene.',
    )
    bpy.types.Scene.runpod_camera = bpy.props.PointerProperty(
        name='Camera',
        type=bpy.types.Object,
        description='Camera to render from. Empty means the selected scene camera.',
        poll=lambda self, obj: obj.type == 'CAMERA',
    )
    bpy.types.Scene.runpod_project = bpy.props.EnumProperty(
        name='Project',
        description='Optional dashboard project. Refresh projects after connecting.',
        items=project_items,
    )
    bpy.types.Scene.rendersphere_flow_state = bpy.props.EnumProperty(
        name='RenderSphere Flow State',
        description='Current RenderSphere render workflow state',
        items=FLOW_ITEMS,
        default='SETUP',
    )


def unregister():
    for prop_name in [
        'runpod_engine',
        'runpod_quality_preset',
        'runpod_samples',
        'runpod_render_type',
        'runpod_is_animation',
        'runpod_frame_start',
        'runpod_frame_end',
        'runpod_output_format',
        'runpod_resolution_pct',
        'runpod_use_scene_frames',
        'runpod_denoiser',
        'runpod_noise_threshold',
        'runpod_advanced_mode',
        'runpod_gpu_device_type',
        'runpod_allow_cpu_fallback',
        'runpod_frame_step',
        'runpod_transparent_film',
        'runpod_use_persistent_data',
        'runpod_view_transform',
        'runpod_look',
        'runpod_exposure',
        'runpod_gamma',
        'runpod_max_bounces',
        'runpod_diffuse_bounces',
        'runpod_glossy_bounces',
        'runpod_transmission_bounces',
        'runpod_transparent_bounces',
        'runpod_caustics_reflective',
        'runpod_caustics_refractive',
        'runpod_use_simplify',
        'runpod_simplify_subdivisions',
        'runpod_simplify_texture_limit',
        'runpod_scene',
        'runpod_camera',
        'runpod_project',
        'rendersphere_flow_state',
    ]:
        if hasattr(bpy.types.Scene, prop_name):
            delattr(bpy.types.Scene, prop_name)

    for cls in reversed(classes):
        bpy.utils.unregister_class(cls)


if __name__ == '__main__':
    register()
