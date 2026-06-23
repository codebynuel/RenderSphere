# RenderSphere Production Deployment Guide

This guide describes the current production model for the RenderSphere web gateway, built frontend, PostgreSQL/Prisma database, RunPod worker, PayPal prepaid-credit top-ups, production logging, health checks, and safe metrics snapshots. It intentionally does not cover legal policies or multi-instance job polling coordination.

## Runtime Components

- Web gateway: Node/Express app from `server.js` serving `/api/*`, Socket.IO, health checks, and static frontend assets from `public/`.
- Frontend: Vite/React app from `frontend/`, built into `public/` and served by the web gateway.
- Database: PostgreSQL accessed through Prisma.
- Worker: existing RunPod Blender worker image built from `Dockerfile` and `handler.py`.
- Object storage: Cloudflare R2 for uploaded source files and rendered outputs.

The web image is separate from the RunPod worker image. Use `Dockerfile.web` for the web gateway/frontend and keep `Dockerfile` for the GPU worker.

## Required Production Environment Variables

The web gateway fails fast in production when required configuration is missing or invalid.

Required for production web startup:

- `NODE_ENV=production`
- `DATABASE_URL`
- `RENDERSPHERE_PUBLIC_URL`
- `CLOUDFLARE_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET_NAME`
- `RUNPOD_ENDPOINT_ID`
- `RUNPOD_API_KEY`

Recommended web variables:

- `PORT`
- `PUBLIC_HTTP_PORT`
- `RENDERSPHERE_SUPPORT_EMAIL`
- `RENDERSPHERE_INVITE_CODE`
- `RENDERSPHERE_ADMIN_TOKEN`
- `RENDERSPHERE_SECURE_COOKIES=true`
- `RENDERSPHERE_SOCKET_ORIGIN=https://your-production-domain.example`
- `RENDERSPHERE_JOB_POLL_INTERVAL_MS`
- `RENDERSPHERE_FREE_RENDER_CREDITS_USD`
- `RENDERSPHERE_MIN_RENDER_START_BALANCE_USD`
- `RENDERSPHERE_MAX_UPLOAD_MB`
- `RENDERSPHERE_MAX_RENDER_SAMPLES`
- `RENDERSPHERE_MAX_RESOLUTION_PCT`
- `RENDERSPHERE_MAX_ANIMATION_FRAMES`
- `RENDERSPHERE_MAX_CONCURRENT_JOBS`
- `RENDERSPHERE_MAX_QUEUED_JOBS`
- `RENDERSPHERE_RENDER_PRICE_PER_SECOND_USD`
- `RENDERSPHERE_RENDER_ESTIMATE_BASE_SECONDS_PER_FRAME`
- `RENDERSPHERE_MIN_RENDER_RESERVATION_USD`
- `RENDERSPHERE_DEFAULT_RENDER_MAX_BUDGET_USD`
- `RENDERSPHERE_MAX_RENDER_BUDGET_USD`
- `RENDERSPHERE_JOB_RECORD_RETENTION_DAYS`
- `RENDERSPHERE_DEFAULT_PAGE_SIZE`
- `RENDERSPHERE_MAX_PAGE_SIZE`
- `RENDERSPHERE_RATE_LIMIT_STORE`
- `RENDERSPHERE_RATE_LIMIT_REDIS_URL`
- `RENDERSPHERE_RATE_LIMIT_KEY_PREFIX`
- `RENDERSPHERE_AUTH_RATE_LIMIT_WINDOW_MS`
- `RENDERSPHERE_AUTH_RATE_LIMIT_MAX`
- `RENDERSPHERE_ACCOUNT_RATE_LIMIT_WINDOW_MS`
- `RENDERSPHERE_ACCOUNT_RATE_LIMIT_MAX`
- `RENDERSPHERE_RENDER_RATE_LIMIT_WINDOW_MS`
- `RENDERSPHERE_RENDER_RATE_LIMIT_MAX`
- `RENDERSPHERE_RUNPOD_REQUEST_TIMEOUT_MS`
- `RENDERSPHERE_RUNPOD_STATUS_MAX_RETRIES`
- `RENDERSPHERE_RUNPOD_CANCEL_MAX_RETRIES`
- `RENDERSPHERE_RUNPOD_RETRY_BACKOFF_MS`
- `RENDERSPHERE_LOG_LEVEL`
- `RENDERSPHERE_LOG_FORMAT`
- `RENDERSPHERE_REQUEST_LOGGING`
- `RENDERSPHERE_PUBLIC_METRICS`
- `RENDERSPHERE_PAYPAL_ENVIRONMENT`
- `RENDERSPHERE_PAYPAL_CLIENT_ID`
- `RENDERSPHERE_PAYPAL_CLIENT_SECRET`
- `RENDERSPHERE_PAYPAL_WEBHOOK_ID`
- `RENDERSPHERE_PAYPAL_PREPAID_PACKAGES`
- `RENDERSPHERE_PAYPAL_CUSTOM_TOPUP_MIN_USD`
- `RENDERSPHERE_PAYPAL_CUSTOM_TOPUP_MAX_USD`
- `RENDERSPHERE_PAYPAL_CUSTOM_TOPUP_CURRENCY`
- `RENDERSPHERE_PAYPAL_CUSTOM_TOPUP_DECIMAL_PLACES`

Validation rules:

- `DATABASE_URL` must be a PostgreSQL URL.
- `RENDERSPHERE_PUBLIC_URL` must be a valid URL in production.
- `RENDERSPHERE_RATE_LIMIT_STORE` must be `memory` or `redis`.
- `RENDERSPHERE_RATE_LIMIT_REDIS_URL` is required when `RENDERSPHERE_RATE_LIMIT_STORE=redis`.
- Default page size cannot exceed max page size.
- Default render budget and minimum reservation cannot exceed the configured max render budget.
- `RENDERSPHERE_PAYPAL_ENVIRONMENT` must be `sandbox` or `live` when provided.
- `RENDERSPHERE_PAYPAL_PREPAID_PACKAGES` must resolve to at least one valid server-side package.
- Custom PayPal top-up minimum and maximum amounts must be positive, minimum cannot exceed maximum, currency must be a three-letter code, and decimal places must be an integer from 0 through 6.

Local development only requires `DATABASE_URL` at server startup so developers can run the gateway without real R2/RunPod/PayPal credentials until they exercise those integrations.

## Build and Release Flow

### Local validation build

Install backend dependencies and build frontend assets:

```bash
pnpm install --frozen-lockfile
pnpm db:generate
pnpm --dir frontend install --frozen-lockfile
pnpm --dir frontend build
```

The root script equivalent is:

```bash
pnpm release:prepare
```

Run the non-destructive release gate before opening or merging a release pull request:

```bash
pnpm release:verify
```

`pnpm release:verify` runs backend syntax validation, Prisma schema validation/client generation, frontend lint, frontend production build, extension packaging/checksum verification, and production dependency audits for the root and frontend manifests. It intentionally does not run migrations or smoke tests because those require an isolated PostgreSQL database.

When an isolated PostgreSQL database or disposable schema is available, set `DATABASE_URL` and `SMOKE_TEST_DATABASE_URL` to non-production URLs and run:

```bash
pnpm release:verify:db
```

This first verifies that the database URLs use isolated schema query parameters, then deploys migrations, verifies migration status, and runs smoke tests. Never point these commands at production or production-like data unless the step is explicitly the reviewed production migration deploy.

### Web image

Build the production web image:

```bash
docker build -f Dockerfile.web -t rendersphere-web:latest .
```

`Dockerfile.web` performs these stages:

1. Installs backend dependencies with the root lockfile.
2. Installs frontend dependencies with the frontend lockfile.
3. Builds the Vite app into `public/`.
4. Generates the Prisma client.
5. Produces a non-root production image that runs `npm run start:prod`.

The image does not run migrations automatically in `CMD`. Run Prisma migrations as a separate release step before routing traffic to the new web container.

### Worker image

The RunPod worker image remains unchanged and is built from the existing worker Dockerfile:

```bash
docker build -f Dockerfile -t blender-runpod-worker:latest .
```

Publish and configure the worker image in RunPod serverless. Required worker variables:

- `R2_ENDPOINT`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET_NAME`

Recommended worker variables:

- `RENDER_TIMEOUT_SECONDS`
- `RENDER_MIN_TMP_FREE_MB`

Use least-privilege R2 credentials for the worker. It should only read uploaded source files and write completed render outputs.

## Database Migrations

Use Prisma deploy migrations for production. Do not run destructive commands such as `prisma db push --force-reset` or `prisma migrate reset` against production-like data.

Recommended deployment order:

1. Build and publish the new web image.
2. Confirm database backup/PITR coverage.
3. Run:

   ```bash
   npx prisma migrate deploy
   ```

4. Start or roll the web containers.
5. Check `/healthz` and `/readyz`.

For Docker Compose-style deployments, `docker-compose.prod.example.yml` separates `migrate` from `web` so schema deployment must succeed before the app starts.

## Docker Compose Examples

`docker-compose.yml` remains a local PostgreSQL-only helper for development and smoke tests.

`docker-compose.prod.example.yml` is a production-shaped example with:

- PostgreSQL service and health check.
- One-shot `migrate` service running `npx prisma migrate deploy`.
- `web` service built from `Dockerfile.web`.
- Web health check against `/readyz`.

Before using it, replace placeholder passwords, domain names, and environment values. Prefer secrets management from your deployment platform instead of committing real values.

## Health, Readiness, Logging, and Metrics

The gateway exposes operational endpoints that do not return secret values.

- `GET /healthz` is lightweight liveness. It returns process/service status, uptime, and the request ID without querying PostgreSQL.
- `GET /readyz` is readiness. It checks environment validation, Prisma accessibility, PostgreSQL connectivity, and whether required R2/RunPod configuration groups are present. It returns HTTP 200 when ready and HTTP 503 when not ready, plus alert-ready booleans for database, environment, and provider-configuration failures.
- `GET /api/admin/metrics` is the default metrics snapshot endpoint and requires `RENDERSPHERE_ADMIN_TOKEN` bearer authentication.
- `GET /metrics` exposes the same safe JSON snapshot without authentication only when `RENDERSPHERE_PUBLIC_METRICS=true`. Keep this disabled unless the deployment network restricts access to trusted monitoring infrastructure.

Use `/healthz` for container liveness and `/readyz` for load balancer readiness or deployment gates. Use `/api/admin/metrics` for dashboards and alert evaluation.

### Structured logging

Configure gateway logging with:

- `RENDERSPHERE_LOG_LEVEL=debug|info|warn|error|silent` (`info` in production, `debug` in development by default).
- `RENDERSPHERE_LOG_FORMAT=auto|json|pretty` (`auto` emits JSON in production and readable text in development).
- `RENDERSPHERE_REQUEST_LOGGING=true|false` to enable or disable one completion log per HTTP request.

Every HTTP response includes an `X-Request-Id` header and JSON API responses include `requestId`. Incoming `X-Request-Id` or `X-Correlation-Id` values are honored when they are safe identifier strings; otherwise the gateway generates a UUID. Include this ID in incident notes so application logs, provider dispatch logs, billing logs, and client reports can be correlated.

The logger redacts authorization headers, cookies, session/access tokens, secrets, passwords, API keys, and matching token-looking values before writing. Do not add raw provider payloads, R2 signed URLs, access keys, PayPal access tokens, payment tokens, or user-private scene data to log metadata.

### Metrics snapshot contents

The JSON metrics snapshot includes:

- HTTP request counts, average durations, and maximum durations by normalized route and status class.
- Job counts by status, active-job count, dispatch-status counts, and count of jobs stuck in `DISPATCHING` without a provider ID.
- Billing-state counts, unreleased reservation count, credit transaction counts by type, and audit-event volume for the last hour.
- Provider readiness indicators for PostgreSQL, R2 configuration, RunPod configuration, rate-limit store, and Redis rate-limit configuration.
- Environment readiness summary without secret values.

### Suggested alerts

Start with these alert rules and tune thresholds after observing real traffic:

- `/readyz` returns HTTP 503 for 2 consecutive checks or 2 minutes.
- `providers.runpod.configured=false` or `providers.r2.configured=false` in production.
- `jobs.dispatch.dispatchingWithoutProvider > 0` for more than one polling interval plus expected RunPod dispatch latency; this can indicate a manual reconciliation case.
- `billing.unreleasedReservations > 0` growing for more than 15 minutes, especially with `billing.byState.RELEASING` or `billing.byState.SETTLING` non-zero.
- `jobs.recentlyFailedJobs` above a baseline threshold, or a sudden increase in `jobs.byStatus.DISPATCH_FAILED`.
- HTTP `5xx` request count by route increasing over a short window, especially `/api/trigger-render`, `/api/job-status/:jobId`, and `/api/get-upload-url`.
- Request duration average/max for render dispatch or job-status routes exceeds expected provider timeout windows.
- Credit audit events unexpectedly drop to zero while render activity continues, or spike outside expected operational actions.

### Incident triage notes

For prepaid credits and render dispatch incidents:

1. Capture the user-visible `requestId`, local `jobId`, `providerJobId` when present, and timestamp.
2. Check `/api/admin/metrics` for dispatch, job status, and billing-state counts.
3. Search logs by `requestId`, then by `jobId` and `providerJobId` if the request spans async polling.
4. If a job is `DISPATCHING` with no `providerJobId`, do not release credits until checking whether RunPod accepted the job but the local attachment failed.
5. If `billingState` is `RELEASING` or `SETTLING`, inspect credit ledger/audit rows for idempotency keys before retrying any repair action.
6. If RunPod status polling is failing, compare provider readiness, RunPod dashboard health, and `RUNPOD_*` timeout/retry configuration.
7. For R2 incidents, confirm signed upload/download errors in logs, bucket credentials/configuration readiness, and object lifecycle rules before re-rendering user jobs.

Do not reset production data during incident response. Prefer idempotent service helpers and additive repair scripts reviewed against ledger/audit records.

## Frontend Static Assets

Production serves the built frontend from `public/` in the web container. The Vite build output directory is configured in `frontend/vite.config.js` as `../public`. The Express fallback serves frontend routes for non-API GET requests while excluding system endpoints such as `/healthz` and `/readyz`.

If a CDN is added later, keep API and Socket.IO routing pointed at the gateway and ensure cache rules do not cache authenticated API responses.

## CI and Release Gates

The Docker workflow is the production release validation gate. It preserves the existing RunPod worker image publishing path while adding pull-request and push validation for the web gateway, database, frontend, dependency, Docker, and extension artifact checks.

CI jobs:

- `Backend, Prisma, migrations, and smoke tests` installs root dependencies, runs backend syntax/static validation, validates and generates Prisma, verifies isolated PostgreSQL schema targets, deploys migrations to a disposable PostgreSQL service schema, checks migration status, and runs smoke tests against a separate isolated schema.
- `Frontend lint and production build` installs frontend dependencies, runs ESLint, and builds production assets.
- `Dependency audit` runs root and standalone frontend production dependency audits with a high-severity threshold.
- `Extension package and checksum validation` packages the Blender add-on, writes and verifies SHA-256 checksums, and uploads both public download artifacts and checksum files.
- `Validate web gateway image` builds `Dockerfile.web` without pushing.
- `Validate RunPod worker image` builds `Dockerfile` without pushing.
- `Build and push RunPod worker` runs only on non-pull-request events after all validation jobs pass, logs in to Docker Hub, and publishes `latest` plus the commit SHA tag.

Required GitHub secrets for worker publishing:

- `DOCKERHUB_USERNAME`
- `DOCKERHUB_TOKEN`

No production application secrets are required for CI validation. CI uses disposable PostgreSQL credentials from the job service container and mock provider configuration in smoke tests. Do not add real R2, RunPod, PayPal, admin, payment, or database secrets to CI logs.

### Release checklist

1. Confirm the release branch is current and review database migration diffs.
2. Run `pnpm release:verify` locally.
3. If a disposable database is available, run `pnpm release:verify:db` with isolated `DATABASE_URL` and `SMOKE_TEST_DATABASE_URL` values.
4. If Docker is available, run `pnpm docker:build:web` and `pnpm docker:build:worker`, or rely on the CI image validation jobs.
5. Package the extension with the production public URL and verify checksums:

   ```bash
   RENDERSPHERE_PUBLIC_URL=https://your-production-domain.example pnpm package:extension:verify
   ```

6. Open or update the pull request and wait for all CI release-gate jobs to pass.
7. After merge, confirm the worker image publish job completed when the release affects the worker path.
8. Run production migrations as a reviewed deployment step with `npx prisma migrate deploy`.
9. Roll the web deployment, check `/healthz` and `/readyz`, and monitor `/api/admin/metrics`.

### Artifact checksum procedure

The add-on package is written to both download locations:

- `public/downloads/rendersphere-blender-addon.zip`
- `frontend/public/downloads/rendersphere-blender-addon.zip`

Run:

```bash
pnpm package:extension:verify
```

The command packages the add-on, writes `.sha256` files next to both zip files, verifies both checksum files, and fails if the two zip artifacts differ. CI then runs `git diff --exit-code` for both zip files and checksum files so artifact drift fails the release gate. The checksum files contain only SHA-256 digests and artifact filenames; they do not contain secrets. For reproducible package bytes, `scripts/package-extension.mjs` uses a deterministic ZIP timestamp by default and honors `SOURCE_DATE_EPOCH` when set.

To verify existing artifacts without rewriting them, run:

```bash
pnpm checksums:extension:verify
```

### CI failure triage

- Backend syntax/static validation: run `pnpm lint:backend` locally and inspect the reported file.
- Prisma validate/generate: run `pnpm prisma:validate` and `pnpm db:generate`; verify `DATABASE_URL` is a valid PostgreSQL URL when the command needs datasource resolution.
- Migration deploy/status: run `pnpm db:check-isolated` and reproduce with a disposable schema. Do not use `prisma db push --force-reset`, `prisma migrate reset`, or any drop/reset command against production-like data.
- Smoke tests: verify `SMOKE_TEST_DATABASE_URL` points to an isolated PostgreSQL schema whose query parameter starts with `smoke_`, `ci_`, `test_`, `disposable_`, or `local_`, and that port `3999` or `SMOKE_TEST_PORT` is free.
- Frontend lint/build: run `pnpm --dir frontend lint` and `pnpm --dir frontend build`.
- Dependency audit: review the advisory, patched version, exploitability, and whether the vulnerable package is in production dependency scope. The frontend audit intentionally uses `--config.ignore-workspace=true` so it audits `frontend/pnpm-lock.yaml` instead of the root workspace lockfile. Keep the CI threshold at high severity unless a documented exception is approved.
- Docker image validation: inspect Docker build logs for lockfile drift, missing copied files, or unavailable external downloads. Worker image failures can also come from Blender/CUDA base-image download problems.
- Extension artifact validation: rerun `pnpm package:extension:verify` and ensure both zip files plus `.sha256` files are committed when release artifacts intentionally change.

## Rollback Procedure

1. Stop routing new traffic to the bad web revision.
2. Roll the web deployment back to the previous known-good image tag.
3. Check `/healthz` and `/readyz` on the restored revision.
4. If the failed release included migrations, review whether the migration was backward-compatible before rolling app code back. Current migration policy should favor additive/backward-compatible changes.
5. Do not reset or drop production data. Use database backup/PITR only as an explicit incident-recovery action.

## PayPal Prepaid Top-ups

RenderSphere supports PayPal Orders API prepaid top-ups for configured credit packages and custom user-entered amounts. Package orders accept only a package ID and the gateway looks up amount/currency from server configuration. Custom orders accept an amount and currency, but the gateway validates them against server-side minimum, maximum, allowed currency, and decimal precision before creating the PayPal order, so browser-sent amounts are never trusted blindly.

### PayPal app setup

1. Create or select a PayPal REST app in the PayPal developer dashboard.
2. Use `RENDERSPHERE_PAYPAL_ENVIRONMENT=sandbox` with sandbox app credentials for test deployments.
3. Switch to `RENDERSPHERE_PAYPAL_ENVIRONMENT=live` only after PayPal account/app approval and operational sign-off.
4. Set the app return URL to `${RENDERSPHERE_PUBLIC_URL}/dashboard?view=billing&paypal=return` and cancel URL to `${RENDERSPHERE_PUBLIC_URL}/dashboard?view=billing&paypal=cancel`.
5. Store credentials in the deployment secrets manager, not in source control:
   - `RENDERSPHERE_PAYPAL_CLIENT_ID`
   - `RENDERSPHERE_PAYPAL_CLIENT_SECRET`
   - optional `RENDERSPHERE_PAYPAL_WEBHOOK_ID` for future webhook verification work.

### Package configuration

Configure packages with `RENDERSPHERE_PAYPAL_PREPAID_PACKAGES`. The compact format is:

```text
starter-10:10:USD:$10 prepaid credits,creator-25:25:USD:$25 prepaid credits,studio-50:50:USD:$50 prepaid credits
```

A JSON array is also accepted, for example:

```json
[
  { "id": "starter-10", "amountUsd": 10, "currency": "USD", "label": "$10 prepaid credits" },
  { "id": "creator-25", "amountUsd": 25, "currency": "USD", "label": "$25 prepaid credits" }
]
```

Package IDs must be stable because they are stored on `PrepaidTopUpOrder` records. Existing package orders store their amount/currency at creation time, so capture no longer requires a package to remain configured, but keep IDs stable for support, reporting, and recharge history clarity.

### Custom amount configuration

Configure custom top-up limits with:

```env
RENDERSPHERE_PAYPAL_CUSTOM_TOPUP_MIN_USD=5
RENDERSPHERE_PAYPAL_CUSTOM_TOPUP_MAX_USD=500
RENDERSPHERE_PAYPAL_CUSTOM_TOPUP_CURRENCY=USD
RENDERSPHERE_PAYPAL_CUSTOM_TOPUP_DECIMAL_PLACES=2
```

The Billing page reads these values from `GET /api/billing/prepaid-packages` and uses them for client-side guidance only. The gateway repeats validation on `POST /api/billing/paypal/orders` and rejects amounts below the minimum, above the maximum, using the wrong currency, or using more decimal places than configured.

### Order and capture behavior

Authenticated users use `POST /api/billing/paypal/orders` with either a package ID or a custom amount payload, not both. The gateway creates a PayPal order and persists a `PrepaidTopUpOrder` row with status, amount, currency, top-up type, nullable package ID, approval URL, and provider order ID. The Billing page redirects the user to PayPal approval.

After PayPal returns to the Billing page, the frontend calls `POST /api/billing/paypal/orders/:providerOrderId/capture`. The gateway captures the provider order, verifies that the captured currency and amount match the stored top-up amount, then credits the user by calling the ledger helper with transaction type `PREPAID_TOP_UP` and an idempotency key derived from the PayPal order/capture IDs. A successful capture links the `PrepaidTopUpOrder` to the resulting `CreditTransaction`.

`GET /api/billing/recharges` returns paginated recharge records for the authenticated user. Use this endpoint, not PayPal payloads exposed to the browser, for customer-visible recharge history.

### Testing and operations

Smoke tests use `RENDERSPHERE_PAYPAL_MOCK=true`, which avoids PayPal network calls and generates deterministic mock order/capture responses. Never enable mock mode in live production. For sandbox manual testing, create a sandbox buyer and seller account in PayPal, top up from Billing, return to RenderSphere, and confirm that credit balance increases exactly once even if capture is retried.

Operational notes:

- Do not log PayPal client secrets, access tokens, or raw provider payloads.
- Do not manually update `User.starterBalanceUsd` for PayPal incidents. Inspect `PrepaidTopUpOrder`, `CreditTransaction`, and `CreditAuditEvent` rows and retry idempotent capture or apply reviewed ledger repairs.
- If capture returns a completed order with a mismatched amount/currency, the local top-up record is marked `FAILED` and no credits are issued. Investigate PayPal dashboard, package/custom configuration, and the stored top-up amount before retrying.
- Webhook processing is not required for the current capture-on-return flow. If webhooks are added later, verify signatures with `RENDERSPHERE_PAYPAL_WEBHOOK_ID` and keep ledger idempotency keys unchanged.

## Prepaid Credit Ledger

Prepaid credits are tracked with an append-only ledger backed by the `CreditTransaction` and `CreditAuditEvent` tables. The legacy `User.starterBalanceUsd` field remains as the current balance cache for compatibility with existing dashboard and render-start checks, but balance-changing code must write a ledger row and an audit event in the same Prisma transaction that updates the cache.

Ledger money fields use PostgreSQL decimal columns through Prisma `Decimal` values. New money fields should not use floating-point columns. Existing job pricing fields remain unchanged for compatibility and can be migrated separately.

Supported transaction types are:

- `CREDIT_GRANT` for system-issued starter grants.
- `PROMO_CREDIT` for promotional grants.
- `PREPAID_TOP_UP` for PayPal payment-provider recharge completion.
- `RENDER_RESERVATION_HOLD` for pre-render holds.
- `RENDER_CHARGE` for completed render deductions.
- `REFUND` and `RESERVATION_RELEASE` for returning user credits.
- `ADMIN_ADJUSTMENT` for controlled manual corrections.

Operational rules:

- Use the credit service helpers instead of directly incrementing or decrementing `User.starterBalanceUsd`.
- Supply an `idempotencyKey` for any operation that can be retried.
- Include `referenceType`, `referenceId`, optional `jobId`, and safe actor metadata when available.
- Keep audit metadata operational only; do not include secrets, payment tokens, access keys, or private render payloads.
- Debit helpers prevent negative cached balances by default.
- PayPal checkout/capture must use `PrepaidTopUpOrder` records plus ledger idempotency keys so a provider retry or duplicate browser confirmation credits exactly once.

## Render Credit Reservations and Budgets

Render start estimates a conservative preauthorized amount from normalized render settings, configured seconds-per-frame, output format, engine, denoiser, samples, resolution, and animation frame count. It reserves prepaid credits before dispatching to RunPod.

Budget configuration:

- `RENDERSPHERE_RENDER_PRICE_PER_SECOND_USD` controls final billing and estimates.
- `RENDERSPHERE_RENDER_ESTIMATE_BASE_SECONDS_PER_FRAME` controls the estimate baseline.
- `RENDERSPHERE_MIN_RENDER_RESERVATION_USD` sets the smallest hold amount.
- `RENDERSPHERE_DEFAULT_RENDER_MAX_BUDGET_USD` is the safe server-side fallback if the client does not pass a budget.
- `RENDERSPHERE_MAX_RENDER_BUDGET_USD` caps client-requested budgets and final charged amount.

Reservation behavior:

- The gateway rejects render start with HTTP 402 before local job creation or RunPod dispatch if available credits are lower than the required reservation.
- Accepted submissions create a local job and a `RENDER_RESERVATION_HOLD` before calling RunPod.
- After RunPod accepts dispatch, the gateway stores provider dispatch metadata and clients continue using the local `jobId`.
- Pre-acceptance dispatch failures release the pending hold.
- Completed jobs release the hold and apply idempotent final `RENDER_CHARGE` capped by `maxBudgetUsd`.
- Failed or cancelled jobs release unreleased holds and mark billing as released.

## RunPod Dispatch Idempotency and Reconciliation

Render submission accepts an optional `Idempotency-Key` or `X-Idempotency-Key` header, or `idempotencyKey` / `clientRequestId` request body field. The server scopes this value per user and stores it on `Job.idempotencyKey` with a unique index.

Operational behavior:

- Retrying with the same idempotency key after provider acceptance returns the existing local/provider job.
- Retrying while the local job is still pending/dispatching returns the existing local job state.
- Retrying after a pre-acceptance dispatch failure returns HTTP 409 with the failed local job; use a new idempotency key for an intentional fresh submission.
- The local `jobId` is the application identifier. `providerJobId` is the RunPod identifier.
- Jobs stuck in `dispatchStatus=DISPATCHING` with no `providerJobId` require manual reconciliation before releasing holds.

Provider-call resilience:

- RunPod status and cancellation calls use request timeouts, bounded retries, and exponential backoff for transient failures.
- RunPod dispatch does not automatically retry unsafe `/run` calls inside the provider helper.
- Provider errors returned to clients are sanitized and include a `retryable` boolean when available.

## API Pagination and Abuse Controls

Collection endpoints use bounded server-side pagination by default. Supported query parameters are `page` and `pageSize` with legacy alias `limit` where supported. `RENDERSPHERE_DEFAULT_PAGE_SIZE` and `RENDERSPHERE_MAX_PAGE_SIZE` enforce defaults and upper bounds.

Paginated endpoints currently include:

- `GET /api/jobs`
- `GET /api/rendered-files`
- `GET /api/projects`
- `GET /api/auth/access-keys`

Rate limiting is centralized through the security helper store abstraction. `RENDERSPHERE_RATE_LIMIT_STORE=memory` is appropriate for a single web instance. For multi-instance production, use `RENDERSPHERE_RATE_LIMIT_STORE=redis` and set `RENDERSPHERE_RATE_LIMIT_REDIS_URL` after adding/validating the Redis runtime dependency in the image.

## Admin Endpoints

Set `RENDERSPHERE_ADMIN_TOKEN` to enable admin endpoints. Use it as a bearer token.

- `GET /api/admin/summary`
- `GET /api/admin/users`
- `GET /api/admin/jobs`
- `GET /api/admin/metrics`
- `POST /api/admin/cleanup-records`

These endpoints are JSON-only for the MVP.

## Web Sessions

The web dashboard uses an HTTP-only `rs_session` cookie. Set `NODE_ENV=production` or `RENDERSPHERE_SECURE_COOKIES=true` in production so session cookies include the `Secure` attribute. Bearer tokens are still supported for the Blender add-on API key and admin endpoints.

## R2 Lifecycle Rules

Configure R2 lifecycle rules outside the app so storage does not grow forever.

Suggested MVP rules:

- Delete `renders/` source uploads after 7 days.
- Delete `finished_renders/` outputs after 14-30 days.
- Keep a shorter retention period while the product is free or invite-only.

The app-level `POST /api/admin/cleanup-records` endpoint only cleans database metadata. It does not delete R2 objects.

## Add-on Packaging

Generate the downloadable add-on zip and checksums with:

```bash
RENDERSPHERE_PUBLIC_URL=https://your-production-domain.example pnpm package:extension:verify
```

If `RENDERSPHERE_PUBLIC_URL` is omitted, the packaged add-on keeps the local development gateway URL. Commit both zip files and their `.sha256` files when the packaged artifact intentionally changes.
