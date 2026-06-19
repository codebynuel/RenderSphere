# RenderSphere Production Deployment Guide

This guide describes the current production model for the RenderSphere web gateway, built frontend, PostgreSQL/Prisma database, RunPod worker, production logging, health checks, and safe metrics snapshots. It intentionally does not cover payment-provider top-ups, legal policies, or multi-instance job polling coordination.

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

Validation rules:

- `DATABASE_URL` must be a PostgreSQL URL.
- `RENDERSPHERE_PUBLIC_URL` must be a valid URL in production.
- `RENDERSPHERE_RATE_LIMIT_STORE` must be `memory` or `redis`.
- `RENDERSPHERE_RATE_LIMIT_REDIS_URL` is required when `RENDERSPHERE_RATE_LIMIT_STORE=redis`.
- Default page size cannot exceed max page size.
- Default render budget and minimum reservation cannot exceed the configured max render budget.

Local development only requires `DATABASE_URL` at server startup so developers can run the gateway without real R2/RunPod credentials until they exercise those integrations.

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

The logger redacts authorization headers, cookies, session/access tokens, secrets, passwords, API keys, and matching token-looking values before writing. Do not add raw provider payloads, R2 signed URLs, access keys, payment tokens, or user-private scene data to log metadata.

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

## CI

The Docker workflow builds and pushes the existing RunPod worker image and validates the web gateway image build. The worker push path is preserved. The web job currently builds only; add registry push credentials/tags when the production web registry is chosen.

## Rollback Procedure

1. Stop routing new traffic to the bad web revision.
2. Roll the web deployment back to the previous known-good image tag.
3. Check `/healthz` and `/readyz` on the restored revision.
4. If the failed release included migrations, review whether the migration was backward-compatible before rolling app code back. Current migration policy should favor additive/backward-compatible changes.
5. Do not reset or drop production data. Use database backup/PITR only as an explicit incident-recovery action.

## Prepaid Credit Ledger

Prepaid credits are tracked with an append-only ledger backed by the `CreditTransaction` and `CreditAuditEvent` tables. The legacy `User.starterBalanceUsd` field remains as the current balance cache for compatibility with existing dashboard and render-start checks, but balance-changing code must write a ledger row and an audit event in the same Prisma transaction that updates the cache.

Ledger money fields use PostgreSQL decimal columns through Prisma `Decimal` values. New money fields should not use floating-point columns. Existing job pricing fields remain unchanged for compatibility and can be migrated separately.

Supported transaction types are:

- `CREDIT_GRANT` for system-issued starter grants.
- `PROMO_CREDIT` for promotional grants.
- `PREPAID_TOP_UP` for future payment-provider recharge completion.
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
- Payment-provider checkout/recharge integration is intentionally out of scope for this batch.

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

Generate the downloadable add-on zip with:

```bash
RENDERSPHERE_PUBLIC_URL=https://your-production-domain.example npm run package:extension
```

If `RENDERSPHERE_PUBLIC_URL` is omitted, the packaged add-on keeps the local development gateway URL.
