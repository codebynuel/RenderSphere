# RenderSphere MVP Production Notes

## Gateway Storage

For the MVP, the gateway can keep using the JSON store if `RENDERSPHERE_DATA_DIR` points at a persistent mounted volume.

Do not run more than one gateway instance against the JSON store. Move to Postgres or another managed database before scaling horizontally.

Required gateway environment variables:

- `CLOUDFLARE_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET_NAME`
- `RUNPOD_ENDPOINT_ID`
- `RUNPOD_API_KEY`

Recommended gateway environment variables:

- `RENDERSPHERE_DATA_DIR`
- `RENDERSPHERE_PUBLIC_URL`
- `RENDERSPHERE_SUPPORT_EMAIL`
- `RENDERSPHERE_INVITE_CODE`
- `RENDERSPHERE_ADMIN_TOKEN`
- `RENDERSPHERE_FREE_RENDER_CREDITS`
- `RENDERSPHERE_MAX_UPLOAD_MB`
- `RENDERSPHERE_MAX_RENDER_SAMPLES`
- `RENDERSPHERE_MAX_RESOLUTION_PCT`
- `RENDERSPHERE_MAX_ANIMATION_FRAMES`
- `RENDERSPHERE_MAX_CONCURRENT_JOBS`
- `RENDERSPHERE_MAX_QUEUED_JOBS`
- `RENDERSPHERE_JOB_RECORD_RETENTION_DAYS`

## Admin Endpoints

Set `RENDERSPHERE_ADMIN_TOKEN` to enable admin endpoints. Use it as a bearer token.

- `GET /api/admin/summary`
- `GET /api/admin/users`
- `GET /api/admin/jobs`
- `POST /api/admin/cleanup-records`

These endpoints are intentionally JSON-only for the MVP.

## Worker Environment

Required RunPod worker environment variables:

- `R2_ENDPOINT`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET_NAME`

Recommended RunPod worker environment variables:

- `RENDER_TIMEOUT_SECONDS`
- `RENDER_MIN_TMP_FREE_MB`

Use least-privilege R2 credentials for the worker. It should only be able to read uploaded source files and write completed render outputs.

## R2 Lifecycle Rules

Configure R2 lifecycle rules outside the app so storage does not grow forever.

Suggested MVP rules:

- Delete `renders/` source uploads after 7 days.
- Delete `finished_renders/` outputs after 14-30 days.
- Keep a shorter retention period while the product is free or invite-only.

The app-level `POST /api/admin/cleanup-records` endpoint only cleans local JSON metadata. It does not delete R2 objects.

## Add-on Packaging

Generate the downloadable add-on zip with:

```bash
RENDERSPHERE_PUBLIC_URL=https://your-production-domain.example npm run package:extension
```

If `RENDERSPHERE_PUBLIC_URL` is omitted, the packaged add-on keeps the local development gateway URL.

