# RenderSphere MVP Production Fixes

Use this as the pre-launch checklist before taking the MVP live.

## Product Notes

RenderSphere is a strong MVP idea because the workflow pain is real: Blender users hate leaving Blender, manually packing scenes, uploading files, polling status, and downloading results. The current product already has the right core loop:

- account
- API key
- Blender add-on
- upload `.blend`
- dispatch RunPod render
- poll progress
- download result

The biggest risk is not whether the idea makes sense. The biggest risk is cost and trust. Every render can spend real GPU money, and users are uploading valuable project files. The MVP should launch with enough guardrails to avoid accidental bills, abuse, and confusing failed renders.

## Launch Blockers

- [ ] Update the Blender add-on production URL.
  - Files: `extension/v1.py` and any packaged add-on copy.
  - Current value: `DEFAULT_SERVER_URL = "http://localhost:3000"`
  - Change this to the real HTTPS gateway URL before distributing the add-on.
  - Packaging now supports `RENDERSPHERE_PUBLIC_URL=https://your-domain npm run package:extension`.

- [x] Fix the extension source-of-truth situation.
  - Current source of truth is `extension/v1.py`.
  - Package or copy this file into `public/` only during release.

- [x] Wire the landing page buttons.
  - File: `public/index.html`
  - `Log In` links to `/auth.html`.
  - `Download Extension` links to `/downloads/rendersphere-blender-addon.zip`.
  - Docs CTA was replaced with the account flow for MVP.

- [x] Replace the failing test script.
  - File: `package.json`
  - `npm test` now runs `scripts/smoke-test.mjs`.

- [x] Add fail-fast environment validation.
  - File: `server.js`
  - Validate required variables at startup:
    - `CLOUDFLARE_ACCOUNT_ID`
    - `R2_ACCESS_KEY_ID`
    - `R2_SECRET_ACCESS_KEY`
    - `R2_BUCKET_NAME`
    - `RUNPOD_ENDPOINT_ID`
    - `RUNPOD_API_KEY`

- [x] Decide what to do with JSON file storage.
  - File: `server.js`
  - MVP decision documented in `docs/production.md`: use `RENDERSPHERE_DATA_DIR` on a persistent mounted volume.
  - Better: move users, sessions, uploads, and jobs to Postgres/Supabase/Neon before public launch.

## Absolutely Necessary MVP Features

- [x] Add cost controls before allowing real users.
  - This is the most important missing product feature.
  - New accounts now receive a configurable render credit balance.
  - `/api/trigger-render` rejects accounts with no credits.

- [x] Add render limits on the server.
  - File: `server.js`
  - Validate and cap:
    - max samples
    - max resolution percentage
    - max animation frame count
    - max concurrent jobs per user
    - max queued jobs per user
  - Do not rely only on the Blender UI limits; API clients can call the server directly.

- [x] Add upload size limits.
  - Files: `server.js`, `extension/v1.py`
  - The add-on sends `fileSizeBytes`.
  - The server rejects oversized upload URL requests.
  - The add-on also warns before uploading an oversized packed `.blend`.

- [x] Add basic pricing or usage visibility.
  - Users need to know whether renders are free, limited, paid, or manually approved.
  - Dashboard now shows credits and service limits.
  - Landing page now presents starter MVP limits.

- [x] Add support/contact information.
  - Add a support email or Discord link on the dashboard and landing page.
  - Render failures will happen; users need somewhere obvious to go.

- [x] Add terms/privacy basics.
  - Users upload private `.blend` files and textures.
  - Added `public/terms.html` and `public/privacy.html`.

## Security And Trust

- [x] Add rate limiting.
  - Protect register, login, API key generation, upload URL creation, and render trigger endpoints.
  - Implemented basic in-memory IP rate limits.

- [x] Keep worker credentials least-privilege.
  - File: `handler.py`
  - The worker downloads and opens user `.blend` files in Blender.
  - Documented worker-only env requirements and least-privilege R2 guidance in `docs/production.md`.

- [x] Review public claims on the landing page.
  - File: `public/index.html`
  - Removed unsupported claims and replaced them with MVP limits.

- [ ] Consider replacing `localStorage` session storage later.
  - File: `public/auth.html`
  - Current token storage is acceptable for a fast MVP.
  - For a more serious public launch, use secure HTTP-only cookies.

- [x] Add security headers.
  - File: `server.js`
  - Added baseline security headers for static pages and API responses.

- [x] Add account abuse controls.
  - File: `server.js`
  - Optional invite-code registration is enabled with `RENDERSPHERE_INVITE_CODE`.

- [x] Prevent upload reuse if that is not intentional.
  - File: `server.js`
  - `/api/trigger-render` now rejects already-used upload keys.

## Extension Review

- [x] Package the add-on as a `.zip`, not just a raw `.py` download.
  - File: `extension/v1.py`
  - Blender users expect an installable add-on zip.

- [x] Add a connection test button in the add-on preferences.
  - The add-on should test:
    - gateway URL
    - API key
    - authenticated `/api/auth/me`
  - This will reduce support pain a lot.

- [x] Improve add-on error messages.
  - File: `extension/v1.py`
  - Many `urllib` failures currently collapse into generic statuses like `Upload Error` or `Failed to reach Node Gateway`.
  - Server error bodies are now surfaced in `current_error_msg`.

- [x] Add a pre-upload confirmation for expensive jobs.
  - Show frame count, samples, resolution percentage, and estimated risk/cost before animation renders.
  - This is especially important for animation.

- [x] Add a max file size warning before upload.
  - File: `extension/v1.py`
  - Check the packed `.blend` size before requesting or using the upload URL.

- [x] Clean up temporary packed files after upload.
  - File: `extension/v1.py`
  - The add-on writes `runpod_payload.blend` into Blender's temp directory.
  - Remove it after successful or failed upload when safe.

- [x] Make animation download location configurable.
  - Current behavior saves animation zips to the user's Desktop.
  - Add-on preferences now include an animation download folder.

- [x] Add version/update visibility.
  - The add-on should display its version and ideally link to the latest download.
  - This matters once you start fixing bugs after launch.

## Server And API Review

- [x] Return clearer RunPod errors.
  - File: `server.js`
  - `/api/trigger-render` now returns useful RunPod error/message text when available.

- [x] Add admin visibility.
  - File: `server.js`
  - Added bearer-token admin endpoints for summary, users, jobs, and metadata cleanup.

- [x] Add job lifecycle cleanup.
  - Files: `server.js`, R2 bucket settings
  - Added local metadata cleanup endpoint.
  - Documented R2 lifecycle rules in `docs/production.md`.

- [x] Add idempotency or duplicate-submit protection.
  - File: `server.js`
  - Users can double-click or retry at awkward moments.
  - Reusing the same upload key is now rejected.

- [x] Validate booleans and frame ranges explicitly.
  - File: `server.js`
  - `isAnimation`, `startFrame`, and `endFrame` should be normalized and checked on the server.
  - Reject invalid ranges before RunPod receives them.

- [x] Add health check endpoint.
  - File: `server.js`
  - Added `/healthz`.

## Worker Review

- [x] Add worker-side env validation.
  - File: `handler.py`
  - Validate `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `R2_BUCKET_NAME` at startup.

- [x] Add render timeout protection.
  - File: `handler.py`
  - `subprocess.Popen` can run for a long time.
  - Set a maximum render duration per job or rely on a known RunPod timeout and document it.

- [x] Add worker disk cleanup safeguards.
  - File: `handler.py`
  - Cleanup exists, but large animation zips and failed runs can still stress `/tmp`.
  - Consider checking available disk before render and before zipping.

- [x] Add logs that identify job settings without leaking secrets.
  - File: `handler.py`
  - Log engine, samples, frame range, output format, resolution percentage, and result key.
  - This helps debug failed user renders.

## Operations Checklist

- [ ] Deploy the Express gateway to a production host with HTTPS.
- [ ] Set production R2 and RunPod environment variables.
- [ ] Set `RENDERSPHERE_DATA_DIR` to persistent storage if keeping JSON storage.
- [x] Package `extension/v1.py` as an installable Blender add-on zip.
- [x] Publish the add-on zip somewhere the landing page can link to.
  - Current path: `public/downloads/rendersphere-blender-addon.zip`
- [ ] Confirm the RunPod worker image tag matches the deployed endpoint.
- [x] Review `.github/workflows/docker-image.yml`.
  - It now supports manual runs and pushes `latest` plus the commit SHA tag.
- [x] Add `__pycache__/` to `.gitignore`.
  - A local `__pycache__/` directory is currently untracked.
- [x] Decide whether `public/auth.html` should be committed.
  - It is part of the MVP account dashboard and should be committed.

## Verified During Review

- `server.js` passes `node --check`.
- `handler.py` and `extension/v1.py` parse cleanly with Python AST.
- `npm test` passes.
- Packaged add-on zip expands and `rendersphere.py` parses cleanly.
- Smoke test covers invite-code signup and admin summary auth.
- Add-on packaging was verified with `RENDERSPHERE_PUBLIC_URL`.
- Local auth smoke test passed:
  - register account
  - receive API key
  - call `/api/auth/me` with bearer token
- `.env` is ignored and not tracked.
