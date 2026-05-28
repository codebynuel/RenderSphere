# RenderSphere MVP Production Fixes

Use this as the pre-launch checklist before taking the MVP live.

## Product Notes

RenderSphere is a strong MVP idea because the workflow pain is real: Blender users hate leaving Blender, manually packing scenes, uploading files, polling status, and downloading results. The current product already has the right core loop:

- account
- API key
- Blender add-on
- upload `.blend`
- dispatch cloud render
- poll progress
- download result

The biggest risk is not whether the idea makes sense. The biggest risk is cost and trust. Every render can spend real GPU money, and users are uploading valuable project files. The MVP should launch with enough guardrails to avoid accidental bills, abuse, and confusing failed renders.

## Launch Blockers

- [ ] Update the Blender add-on production URL.
  - Files: `extension/v1.py` and any packaged add-on copy.
  - Current value: `DEFAULT_SERVER_URL = "http://localhost:3000"`
  - Change this to the real HTTPS gateway URL before distributing the add-on.
  - Packaging supports `RENDERSPHERE_PUBLIC_URL=https://your-domain npm run package:extension`.

- [x] Fix the extension source-of-truth situation.
  - Current source of truth is `extension/v1.py`.
  - Package or copy this file into `public/` only during release.

- [x] Wire the landing page buttons.
  - `Download Extension` links to `/downloads/rendersphere-blender-addon.zip`.
  - Docs CTA was replaced with the account flow for MVP.

- [x] Replace the failing test script.
  - File: `package.json`
  - `npm test` runs `scripts/smoke-test.mjs`.

- [x] Add fail-fast environment validation.
  - File: `helpers/config.js`
  - Validate required variables at startup:
    - `DATABASE_URL`
    - `CLOUDFLARE_ACCOUNT_ID`
    - `R2_ACCESS_KEY_ID`
    - `R2_SECRET_ACCESS_KEY`
    - `R2_BUCKET_NAME`
    - `MODAL_RENDER_ENDPOINT_URL`
    - `MODAL_RENDER_TOKEN`

- [x] Use PostgreSQL persistence through Prisma.
  - File: `prisma/schema.prisma`
  - Users, sessions, uploads, jobs, and projects are persisted in PostgreSQL.

## Absolutely Necessary MVP Features

- [x] Add cost controls before allowing real users.
  - New accounts receive a configurable render credit balance.
  - `/api/trigger-render` rejects accounts with no credits.

- [x] Add render limits on the server.
  - Validate and cap:
    - max samples
    - max resolution percentage
    - max animation frame count
    - max concurrent jobs per user
    - max queued jobs per user
  - Do not rely only on the Blender UI limits; API clients can call the server directly.

- [x] Add upload size limits.
  - Files: `src/controllers/renderController.js`, `extension/v1.py`
  - The add-on sends `fileSizeBytes`.
  - The server rejects oversized upload URL requests.
  - The add-on also warns before uploading an oversized packed `.blend`.

- [x] Add basic pricing or usage visibility.
  - Dashboard shows credits and service limits.
  - Landing page presents starter MVP limits.

- [x] Add support/contact information.
  - Support information is visible on the dashboard and landing page.

- [x] Add terms/privacy basics.
  - Users upload private `.blend` files and textures.
  - Terms and privacy pages are available in the frontend.

## Security And Trust

- [x] Add rate limiting.
  - Protect register, login, API key generation, upload URL creation, and render trigger endpoints.
  - Implemented basic in-memory IP rate limits.

- [x] Keep worker credentials least-privilege.
  - Files: `modal_app.py`, `render_worker.py`
  - The worker downloads and opens user `.blend` files in Blender.
  - Documented worker-only env requirements and least-privilege R2 guidance in `docs/production.md`.

- [x] Review public claims on the landing page.
  - Removed unsupported claims and replaced them with MVP limits.

- [x] Use secure browser sessions.
  - Web dashboard sessions use an HTTP-only `rs_session` cookie.
  - Bearer tokens remain supported for the Blender add-on API key and admin endpoints.

- [x] Add security headers.
  - File: `helpers/security.js`
  - Added baseline security headers for static pages and API responses.

- [x] Add account abuse controls.
  - Optional invite-code registration is enabled with `RENDERSPHERE_INVITE_CODE`.

- [x] Prevent upload reuse if that is not intentional.
  - `/api/trigger-render` rejects already-used upload keys.

## Extension Review

- [x] Package the add-on as a `.zip`, not just a raw `.py` download.
  - File: `extension/v1.py`
  - Blender users expect an installable add-on zip.

- [x] Add a connection test button in the add-on preferences.
  - The add-on tests:
    - gateway URL
    - API key
    - authenticated `/api/auth/me`

- [x] Improve add-on error messages.
  - File: `extension/v1.py`
  - Server error bodies are surfaced in `current_error_msg`.

- [x] Add a pre-upload confirmation for expensive jobs.
  - Shows frame count, samples, resolution percentage, and estimated risk/cost before animation renders.

- [x] Add a max file size warning before upload.
  - File: `extension/v1.py`
  - Checks the packed `.blend` size before requesting or using the upload URL.

- [x] Clean up temporary packed files after upload.
  - File: `extension/v1.py`
  - The add-on writes `rendersphere_payload.blend` into Blender's temp directory and removes it after successful or failed upload when safe.

- [x] Make animation download location configurable.
  - Add-on preferences include an animation download folder.

- [x] Add version/update visibility.
  - The add-on displays its version.

- [x] Add Advanced Mode for power users.
  - File: `extension/v1.py`
  - Advanced controls include GPU backend, CPU fallback, frame step, transparent film, color management, bounces, caustics, persistent data, and simplify settings.

## Server And API Review

- [x] Return clearer render errors.
  - Files: `src/services/jobService.js`, `src/services/renderProviderService.js`
  - `/api/trigger-render` and job status polling sanitize provider/runtime errors before user display.

- [x] Add admin visibility.
  - Added bearer-token admin endpoints for summary, users, jobs, and metadata cleanup.

- [x] Add job lifecycle cleanup.
  - Files: `src/controllers/*`, R2 bucket settings
  - Added local metadata cleanup endpoint.
  - Documented R2 lifecycle rules in `docs/production.md`.

- [x] Add idempotency or duplicate-submit protection.
  - Users can double-click or retry at awkward moments.
  - Reusing the same upload key is rejected.

- [x] Validate booleans and frame ranges explicitly.
  - File: `src/services/jobService.js`
  - `isAnimation`, `startFrame`, `endFrame`, and `frameStep` are normalized and checked on the server.

- [x] Add health check endpoint.
  - Added `/healthz`.

## Worker Review

- [x] Add worker-side env validation.
  - File: `render_worker.py`
  - Validates `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `R2_BUCKET_NAME`.

- [x] Add render timeout protection.
  - File: `render_worker.py`
  - `subprocess.Popen` has a maximum render duration per job.

- [x] Add worker disk cleanup safeguards.
  - File: `render_worker.py`
  - Checks available disk before download, zipping, and upload.

- [x] Add logs that identify job settings without leaking secrets.
  - File: `render_worker.py`
  - Logs engine, samples, frame range, output format, resolution percentage, and worker settings.

- [x] Add Modal worker entrypoint.
  - File: `modal_app.py`
  - Exposes `/render`, `/status/:jobId`, and `/cancel/:jobId` endpoints backed by a Modal GPU function.

## Operations Checklist

- [ ] Deploy the Express gateway to a production host with HTTPS.
- [ ] Deploy the Modal worker with `modal deploy modal_app.py`.
- [ ] Set production R2 and Modal environment variables.
- [x] Package `extension/v1.py` as an installable Blender add-on zip.
- [x] Publish the add-on zip somewhere the landing page can link to.
  - Current path: `public/downloads/rendersphere-blender-addon.zip`
- [x] Review `.github/workflows/docker-image.yml`.
  - It now uses provider-neutral worker image naming.
- [x] Add `__pycache__/` to `.gitignore`.

## Verified During Review

- `server.js` passes `node --check`.
- `handler.py`, `render_worker.py`, `modal_app.py`, and `extension/v1.py` parse cleanly with Python bytecode compilation.
- `pnpm --dir frontend lint` passes.
- `pnpm --dir frontend build` passes.
- Packaged add-on zip is regenerated.
- `.env` is ignored and not tracked.
