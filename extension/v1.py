bl_info = {
    "name": "RunPod Render Gateway",
    "author": "Ella",
    "version": (1, 0),
    "blender": (3, 0, 0),
    "location": "View3D > Sidebar > Cloud Render",
    "description": "Packs and uploads the current scene to Cloudflare R2 for RunPod rendering.",
    "category": "Render",
}

import bpy
import os
import json
import urllib.request
import http.client
from urllib.parse import urlparse

class RENDER_OT_cloud_upload(bpy.types.Operator):
    """Pack and upload .blend file to R2 Gateway"""
    bl_idname = "render.cloud_upload"
    bl_label = "Upload & Render on RunPod"
    bl_options = {'REGISTER', 'UNDO'}

    def execute(self, context):
        self.report({'INFO'}, "Packing assets...")
        
        # 1. Pack all external textures and HDRIs
        bpy.ops.file.pack_all()
        
        # 2. Save a temporary copy
        temp_path = os.path.join(bpy.app.tempdir, "runpod_payload.blend")
        bpy.ops.wm.save_as_mainfile(filepath=temp_path, copy=True)
        
        self.report({'INFO'}, "Requesting R2 URL from Gateway...")
        
        # 3. Ping your Express gateway for the R2 pre-signed URL
        api_endpoint = "http://localhost:3000/api/get-upload-url"
        payload = json.dumps({"fileName": "runpod_payload.blend"}).encode('utf-8')
        
        try:
            req = urllib.request.Request(
                api_endpoint, 
                data=payload, 
                headers={'Content-Type': 'application/json'}
            )
            with urllib.request.urlopen(req) as response:
                res_data = json.loads(response.read().decode())
                upload_url = res_data.get("uploadUrl")
                file_key = res_data.get("key")
        except Exception as e:
            self.report({'ERROR'}, f"Gateway Error: {str(e)}")
            return {'CANCELLED'}

        # 4. Stream the file directly to Cloudflare R2
        self.report({'INFO'}, "Uploading to Cloudflare R2...")
        
        try:
            parsed_url = urlparse(upload_url)
            conn = http.client.HTTPSConnection(parsed_url.netloc)
            
            # THE FIX: Get the exact file size in bytes
            file_size = os.path.getsize(temp_path)
            
            with open(temp_path, 'rb') as file_data:
                conn.request(
                    "PUT", 
                    parsed_url.path + "?" + parsed_url.query, 
                    body=file_data, 
                    headers={
                        'Content-Type': 'application/octet-stream',
                        'Content-Length': str(file_size) # Tell R2 exactly how big it is
                    }
                )
                upload_res = conn.getresponse()
                
            if upload_res.status in [200, 201]:
                self.report({'INFO'}, f"Success! File stored at: {file_key}")
                print(f"File stored at: {file_key}")
            else:
                # BETTER LOGGING: Catch the exact XML error from R2
                error_body = upload_res.read().decode('utf-8', errors='ignore')
                print("\n=== CLOUDFLARE R2 UPLOAD ERROR ===")
                print(f"HTTP Status: {upload_res.status}")
                print(f"Error Body: \n{error_body}")
                print("==================================\n")
                
                self.report({'ERROR'}, f"R2 Upload Failed: HTTP {upload_res.status}. Check System Console.")
                return {'CANCELLED'}
                
        except Exception as e:
            self.report({'ERROR'}, f"Upload Error: {str(e)}")
            print(f"Python Exception during upload: {str(e)}")
            return {'CANCELLED'}

        return {'FINISHED'}


class RENDER_PT_cloud_panel(bpy.types.Panel):
    """Creates a Panel in the 3D Viewport Sidebar"""
    bl_label = "Cloud Render Gateway"
    bl_idname = "RENDER_PT_cloud_panel"
    bl_space_type = 'VIEW_3D'
    bl_region_type = 'UI'
    bl_category = 'Cloud Render' # This is the name of the tab in the sidebar

    def draw(self, context):
        layout = self.layout
        layout.label(text="RunPod Infrastructure")
        
        # This adds our custom operator button to the UI
        layout.operator("render.cloud_upload", icon='WORLD')


def register():
    bpy.utils.register_class(RENDER_OT_cloud_upload)
    bpy.utils.register_class(RENDER_PT_cloud_panel)

def unregister():
    bpy.utils.unregister_class(RENDER_OT_cloud_upload)
    bpy.utils.unregister_class(RENDER_PT_cloud_panel)

if __name__ == "__main__":
    register()