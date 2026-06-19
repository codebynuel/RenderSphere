# RenderSphere MVP Production Notes

## Gateway Storage

The gateway now persists metadata in MongoDB.

Set `MONGODB_URI` to your cluster/instance connection string and optionally override `MONGODB_DB_NAME`.

Multiple gateway instances can share the same MongoDB database.

Required gateway environment variables:

- `CLOUDFLARE_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET_NAME`
- `RUNPOD_ENDPOINT_ID`
- `RUNPOD_API_KEY`

Recommended gateway environment variables:

- `MONGODB_URI`
- `MONGODB_DB_NAME`
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

- The gateway rejects render start with HTTP 402 before RunPod dispatch/job creation if available credits are lower than the required reservation.
- Accepted jobs write a `RENDER_RESERVATION_HOLD` ledger row before RunPod dispatch and persist `estimatedCostUsd`, `maxBudgetUsd`, `reservedCreditsUsd`, `billingState`, and `billingMetadata` on `Job`.
- If RunPod dispatch or job creation fails after a hold, the gateway releases the pending hold with `RESERVATION_RELEASE`.
- Completed jobs release the full hold and then apply the idempotent final `RENDER_CHARGE`, capped by `maxBudgetUsd`, so repeated status syncs do not duplicate deductions.
- Failed or cancelled jobs release unreleased holds and mark billing as `RELEASED`.
- Normal reservation, charge, release, and cancellation paths are designed to keep cached balances non-negative.

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

The app-level `POST /api/admin/cleanup-records` endpoint only cleans MongoDB metadata. It does not delete R2 objects.

## Add-on Packaging

Generate the downloadable add-on zip with:

```bash
RENDERSPHERE_PUBLIC_URL=https://your-production-domain.example npm run package:extension
```

If `RENDERSPHERE_PUBLIC_URL` is omitted, the packaged add-on keeps the local development gateway URL.
