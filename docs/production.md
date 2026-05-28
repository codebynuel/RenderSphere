# RenderSphere Production Notes

## Gateway Storage

The gateway persists metadata in PostgreSQL through Prisma.

Required gateway environment variables:

- `DATABASE_URL`
- `CLOUDFLARE_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET_NAME`
- `MODAL_RENDER_ENDPOINT_URL`

Optional gateway environment variables:

- `RENDERSPHERE_PUBLIC_URL`
- `RENDERSPHERE_SUPPORT_EMAIL`
- `RENDERSPHERE_INVITE_CODE`
- `RENDERSPHERE_ADMIN_TOKEN`
- `RENDERSPHERE_SECURE_COOKIES`
- `RENDERSPHERE_FREE_RENDER_CREDITS_USD`
- `RENDERSPHERE_MAX_UPLOAD_MB`
- `RENDERSPHERE_MAX_RENDER_SAMPLES`
- `RENDERSPHERE_MAX_RESOLUTION_PCT`
- `RENDERSPHERE_MAX_ANIMATION_FRAMES`
- `RENDERSPHERE_MAX_CONCURRENT_JOBS`
- `RENDERSPHERE_MAX_QUEUED_JOBS`
- `RENDERSPHERE_JOB_RECORD_RETENTION_DAYS`

## Modal Render Worker

The Modal worker lives in `modal_app.py` and delegates Blender execution to `render_worker.py`.

Create the worker secret for R2 access:

```bash
modal secret create rendersphere-worker-env R2_ENDPOINT=https://your-account.r2.cloudflarestorage.com R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... R2_BUCKET_NAME=...
```

Create the API secret used by the gateway and Modal endpoint:

```bash
modal secret create rendersphere-modal-api MODAL_RENDER_TOKEN=your-shared-token
```

Deploy the worker:

```bash
modal deploy modal_app.py
```

Set `MODAL_RENDER_ENDPOINT_URL` on the gateway to the deployed Modal ASGI app base URL. The gateway calls:

- `POST /render`
- `GET /status/:jobId`
- `DELETE /cancel/:jobId`

Use least-privilege R2 credentials for the worker. It should only be able to read uploaded source files and write completed render outputs.

## Admin Endpoints

Set `RENDERSPHERE_ADMIN_TOKEN` to enable admin endpoints. Use it as a bearer token.

- `GET /api/admin/summary`
- `GET /api/admin/users`
- `GET /api/admin/jobs`
- `POST /api/admin/cleanup-records`

These endpoints are intentionally JSON-only for the MVP.

## Web Sessions

The web dashboard uses an HTTP-only `rs_session` cookie. The browser does not need to store session tokens in `localStorage`.

Set `NODE_ENV=production` or `RENDERSPHERE_SECURE_COOKIES=true` in production so session cookies include the `Secure` attribute.

Bearer tokens are still supported for the Blender add-on API key and admin endpoints.

## R2 Lifecycle Rules

Configure R2 lifecycle rules outside the app so storage does not grow forever.

Suggested MVP rules:

- Delete `renders/` source uploads after 7 days.
- Delete `finished_renders/` outputs after 14-30 days.
- Keep a shorter retention period while the product is free or invite-only.

The app-level `POST /api/admin/cleanup-records` endpoint only cleans database metadata. It does not delete R2 objects.

## Add-on Packaging

Generate the downloadable add-on zip with:

```bash
RENDERSPHERE_PUBLIC_URL=https://your-production-domain.example npm run package:extension
```

If `RENDERSPHERE_PUBLIC_URL` is omitted, the packaged add-on keeps the local development gateway URL.
