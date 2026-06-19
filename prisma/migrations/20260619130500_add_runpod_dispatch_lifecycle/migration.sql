ALTER TABLE "Job" ADD COLUMN "providerJobId" TEXT;
ALTER TABLE "Job" ADD COLUMN "dispatchStatus" TEXT NOT NULL DEFAULT 'PENDING';
ALTER TABLE "Job" ADD COLUMN "idempotencyKey" TEXT;
ALTER TABLE "Job" ADD COLUMN "dispatchMetadata" JSONB;
ALTER TABLE "Job" ADD COLUMN "dispatchedAt" TIMESTAMP(3);

UPDATE "Job"
SET "providerJobId" = "jobId",
    "dispatchStatus" = 'DISPATCHED',
    "dispatchedAt" = COALESCE("createdAt", now())
WHERE "providerJobId" IS NULL;

CREATE UNIQUE INDEX "Job_providerJobId_key" ON "Job"("providerJobId");
CREATE UNIQUE INDEX "Job_idempotencyKey_key" ON "Job"("idempotencyKey");
CREATE INDEX "Job_dispatchStatus_idx" ON "Job"("dispatchStatus");
