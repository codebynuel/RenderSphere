-- Store prepaid render reservation and budget state on jobs.
ALTER TABLE "Job"
    ADD COLUMN "estimatedCostUsd" DECIMAL(12,6),
    ADD COLUMN "maxBudgetUsd" DECIMAL(12,6),
    ADD COLUMN "reservedCreditsUsd" DECIMAL(12,6),
    ADD COLUMN "reservationReleasedAt" TIMESTAMP(3),
    ADD COLUMN "billingState" TEXT NOT NULL DEFAULT 'UNBILLED',
    ADD COLUMN "billingMetadata" JSONB;

CREATE INDEX "Job_billingState_idx" ON "Job"("billingState");
