# RenderSphere MVP Production Notes

## Gateway Storage

The gateway persists metadata in PostgreSQL through Prisma.

Set `DATABASE_URL` to your PostgreSQL connection string. Multiple gateway instances can share the same PostgreSQL database, but deploy rate limiting and background polling with the operational notes below.

Required gateway environment variables:

- `CLOUDFLARE_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET_NAME`
- `RUNPOD_ENDPOINT_ID`
- `RUNPOD_API_KEY`

Recommended gateway environment variables:

- `RENDERSPHERE_PUBLIC_URL`
- `RENDERSPHERE_SUPPORT_EMAIL`
- `RENDERSPHERE_INVITE_CODE`
- `RENDERSPHERE_ADMIN_TOKEN`
- `RENDERSPHERE_SECURE_COOKIES`
- `RENDERSPHERE_FREE_RENDER_CREDITS`
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

## Prepaid Credit Ledger

Prepaid credits are tracked with an append-only ledger backed by the `CreditTransaction` and `CreditAuditEvent` tables. The legacy `User.starterBalanceUsd` field remains as the current balance cache for compatibility with existing dashboard and render-start checks, but balance-changing code must write a ledger row and an audit event in the same Prisma transaction that updates the cache.

Ledger money fields use PostgreSQL decimal columns through Prisma `Decimal` values. New money fields should not use floating-point columns. Existing job pricing fields remain unchanged in this batch for compatibility and can be migrated separately.

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
- Supply an `idempotencyKey` for any operation that can be retried. Render charges use `render-charge:<jobId>` so repeated RunPod status syncs do not double-bill.
- Include `referenceType`, `referenceId`, optional `jobId`, and safe actor metadata (`actorType`, `actorId`, `actorEmail`) whenever available.
- Keep audit metadata operational only; do not include secrets, payment tokens, access keys, or private render payloads.
- Debit helpers prevent negative cached balances by default. Normal render reservation and charge flows must not opt out of this protection.
- Payment-provider checkout/recharge integration is intentionally out of scope for this batch. Future top-up completion handlers should use `PREPAID_TOP_UP` with provider event idempotency.

## Render Credit Reservations and Budgets

Render start no longer checks only the legacy minimum start balance. The server estimates a conservative preauthorized amount from normalized render settings, configured seconds-per-frame, output format, engine, denoiser, samples, resolution, and animation frame count. It then reserves prepaid credits before dispatching to RunPod.

Budget configuration:

- `RENDERSPHERE_RENDER_PRICE_PER_SECOND_USD` controls final billing and estimates.
- `RENDERSPHERE_RENDER_ESTIMATE_BASE_SECONDS_PER_FRAME` controls the estimate baseline.
- `RENDERSPHERE_MIN_RENDER_RESERVATION_USD` sets the smallest hold amount.
- `RENDERSPHERE_DEFAULT_RENDER_MAX_BUDGET_USD` is the safe server-side fallback if the client does not pass a budget.
- `RENDERSPHERE_MAX_RENDER_BUDGET_USD` caps client-requested budgets and final charged amount.

API clients may pass optional `maxBudgetUsd`, `maxBudget`, or `maxRenderBudgetUsd` to `/api/trigger-render`. If omitted, the server fallback budget applies. Existing Blender add-on payloads remain compatible because the budget is optional.

Reservation behavior:

- The gateway rejects render start with HTTP 402 before local job creation or RunPod dispatch if available credits are lower than the required reservation.
- Accepted submissions now create a local `Job` first with a local `jobId`, `dispatchStatus=PENDING/DISPATCHING`, `status=DISPATCHING`, and a `RENDER_RESERVATION_HOLD` before calling RunPod.
- After RunPod accepts the dispatch, the gateway stores `providerJobId`, `dispatchStatus=DISPATCHED`, `dispatchedAt`, and provider details in `dispatchMetadata`. Client APIs continue to return the local `jobId`; provider calls use `providerJobId` when present.
- If RunPod rejects/times out/fails before provider acceptance, the gateway marks the local job `status=DISPATCH_FAILED`, `dispatchStatus=FAILED`, records safe provider classification metadata, and releases the pending hold with `RESERVATION_RELEASE`.
- If RunPod accepts but the local provider-id attachment fails, the gateway retries the local attachment once and logs both the local job id and provider job id for manual reconciliation if that retry also fails.
- Completed jobs release the full hold and then apply the idempotent final `RENDER_CHARGE`, capped by `maxBudgetUsd`, so repeated status syncs do not duplicate deductions.
- Failed or cancelled jobs release unreleased holds and mark billing as `RELEASED`.
- Normal reservation, charge, release, and cancellation paths are designed to keep cached balances non-negative.

## RunPod Dispatch Idempotency and Reconciliation

Render submission accepts an optional `Idempotency-Key` or `X-Idempotency-Key` header, or `idempotencyKey` / `clientRequestId` request body field. The server scopes this value per user and stores it on `Job.idempotencyKey` with a unique index.

Operational behavior:

- Retrying a request with the same idempotency key after provider acceptance returns the existing local/provider job instead of creating another local job or dispatching another provider job.
- Retrying a request with the same idempotency key while the local job is still pending/dispatching returns the existing local job state instead of dispatching again.
- Retrying a request with the same idempotency key after a pre-acceptance dispatch failure returns HTTP 409 with the failed local job. Use a new idempotency key to intentionally submit a fresh provider dispatch after checking the previous job's released hold.
- The local `jobId` is the stable application identifier. `providerJobId` is the RunPod identifier. Admin/reconciliation tooling should inspect both, along with `dispatchStatus`, `dispatchedAt`, `dispatchMetadata`, `billingState`, and `reservationReleasedAt`.
- Jobs stuck in `dispatchStatus=DISPATCHING` with no `providerJobId` did not record provider acceptance. Confirm RunPod externally before either marking them failed/releasing the hold or attaching the provider id manually.
- Jobs with `dispatchStatus=DISPATCHED` and missing/late result state are safe for normal status polling; polling uses `providerJobId` and final billing remains idempotent.

Provider-call resilience:

- RunPod status and cancellation calls use request timeouts, bounded retries, and exponential backoff for transient network/HTTP 408/409/425/429/5xx failures.
- RunPod dispatch uses the same timeout/error classification, but does not automatically retry unsafe `/run` calls inside the provider helper. Submission-level idempotency prevents normal client retries from duplicating accepted jobs.
- Config knobs: `RENDERSPHERE_RUNPOD_REQUEST_TIMEOUT_MS` (default 15000), `RENDERSPHERE_RUNPOD_STATUS_MAX_RETRIES` (default 2), `RENDERSPHERE_RUNPOD_CANCEL_MAX_RETRIES` (default 1), and `RENDERSPHERE_RUNPOD_RETRY_BACKOFF_MS` (default 300).
- Provider errors returned to clients are sanitized and include a `retryable` boolean when available. Logs keep operational identifiers but must not include secrets.

## API Pagination and Abuse Controls

Collection endpoints use bounded server-side pagination by default. Supported query parameters are `page` and `pageSize` (or legacy alias `limit`), with `RENDERSPHERE_DEFAULT_PAGE_SIZE` and `RENDERSPHERE_MAX_PAGE_SIZE` enforcing defaults and upper bounds. Invalid non-integer, zero, negative, or over-limit page sizes return HTTP 400 instead of silently loading all records.

Paginated endpoints currently include:

- `GET /api/jobs` with optional `status=all|active|history|terminal|COMPLETED|FAILED|CANCELLED|DISPATCH_FAILED|SUBMITTED|DISPATCHING|IN_QUEUE|IN_PROGRESS|RUNNING` and optional `search`.
- `GET /api/rendered-files` with optional `search`.
- `GET /api/projects` with optional `search`.
- `GET /api/auth/access-keys`.

Responses preserve the existing top-level arrays (`jobs`, `files`, `projects`, or `accessKeys`) and add `pagination` metadata with `page`, `pageSize`, `totalItems`, `totalPages`, `hasNextPage`, and `hasPreviousPage`. Dashboard views request bounded pages and expose load-more controls where normal workflows need more than the initial server page.

Rate limiting is centralized through the `helpers/security.js` store abstraction. `RENDERSPHERE_RATE_LIMIT_STORE=memory` is the default and is safe for single-instance deployments. For multi-instance production, configure `RENDERSPHERE_RATE_LIMIT_STORE=redis` and `RENDERSPHERE_RATE_LIMIT_REDIS_URL` after adding the `redis` package to the runtime image; otherwise the app logs a Redis-store initialization failure and falls back to process memory. The limiter emits standard `RateLimit-*` and `Retry-After` headers.

Configured limiter scopes:

- Auth attempts (`/api/auth/register`, `/api/auth/login`) are keyed by client IP plus normalized email.
- Account mutations (access-key creation/revocation, legacy API-key creation, project create/update/delete) are keyed by authenticated account when available.
- Expensive render operations (upload URL creation, render submission, cancellation) are keyed by authenticated account.

Tune `RENDERSPHERE_AUTH_RATE_LIMIT_*`, `RENDERSPHERE_ACCOUNT_RATE_LIMIT_*`, and `RENDERSPHERE_RENDER_RATE_LIMIT_*` based on real traffic and provider quotas. Keep limits permissive enough for normal retries and Blender workstation workflows, but low enough to contain scripted abuse.

## Admin Endpoints

Set `RENDERSPHERE_ADMIN_TOKEN` to enable admin endpoints. Use it as a bearer token.

- `GET /api/admin/summary`
- `GET /api/admin/users`
- `GET /api/admin/jobs`
- `POST /api/admin/cleanup-records`

These endpoints are intentionally JSON-only for the MVP.

## Web Sessions

The web dashboard uses an HTTP-only `rs_session` cookie. The browser no longer stores session tokens in `localStorage`.

Set `NODE_ENV=production` or `RENDERSPHERE_SECURE_COOKIES=true` in production so session cookies include the `Secure` attribute.

Bearer tokens are still supported for the Blender add-on API key and admin endpoints.

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

The app-level `POST /api/admin/cleanup-records` endpoint only cleans database metadata. It does not delete R2 objects.

## Add-on Packaging

Generate the downloadable add-on zip with:

```bash
RENDERSPHERE_PUBLIC_URL=https://your-production-domain.example npm run package:extension
```

If `RENDERSPHERE_PUBLIC_URL` is omitted, the packaged add-on keeps the local development gateway URL.
