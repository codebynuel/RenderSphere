-- Add prepaid credit ledger and audit foundation.
CREATE TYPE "CreditTransactionType" AS ENUM (
    'CREDIT_GRANT',
    'PROMO_CREDIT',
    'PREPAID_TOP_UP',
    'RENDER_RESERVATION_HOLD',
    'RENDER_CHARGE',
    'REFUND',
    'RESERVATION_RELEASE',
    'ADMIN_ADJUSTMENT'
);

CREATE TYPE "CreditActorType" AS ENUM (
    'USER',
    'ADMIN',
    'SYSTEM'
);

CREATE TABLE "CreditTransaction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "CreditTransactionType" NOT NULL,
    "amountUsd" DECIMAL(12,6) NOT NULL,
    "balanceBeforeUsd" DECIMAL(12,6) NOT NULL,
    "balanceAfterUsd" DECIMAL(12,6) NOT NULL,
    "actorType" "CreditActorType" NOT NULL DEFAULT 'SYSTEM',
    "actorId" TEXT,
    "actorEmail" TEXT,
    "referenceType" TEXT,
    "referenceId" TEXT,
    "jobId" TEXT,
    "idempotencyKey" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditTransaction_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CreditAuditEvent" (
    "id" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "targetUserId" TEXT,
    "actorType" "CreditActorType" NOT NULL DEFAULT 'SYSTEM',
    "actorId" TEXT,
    "actorEmail" TEXT,
    "creditTransactionId" TEXT,
    "jobId" TEXT,
    "referenceType" TEXT,
    "referenceId" TEXT,
    "idempotencyKey" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditAuditEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CreditTransaction_idempotencyKey_key" ON "CreditTransaction"("idempotencyKey");
CREATE INDEX "CreditTransaction_userId_createdAt_idx" ON "CreditTransaction"("userId", "createdAt");
CREATE INDEX "CreditTransaction_userId_type_idx" ON "CreditTransaction"("userId", "type");
CREATE INDEX "CreditTransaction_referenceType_referenceId_idx" ON "CreditTransaction"("referenceType", "referenceId");
CREATE INDEX "CreditTransaction_jobId_idx" ON "CreditTransaction"("jobId");
CREATE INDEX "CreditAuditEvent_targetUserId_createdAt_idx" ON "CreditAuditEvent"("targetUserId", "createdAt");
CREATE INDEX "CreditAuditEvent_creditTransactionId_idx" ON "CreditAuditEvent"("creditTransactionId");
CREATE INDEX "CreditAuditEvent_jobId_idx" ON "CreditAuditEvent"("jobId");
CREATE INDEX "CreditAuditEvent_eventType_createdAt_idx" ON "CreditAuditEvent"("eventType", "createdAt");
CREATE INDEX "CreditAuditEvent_referenceType_referenceId_idx" ON "CreditAuditEvent"("referenceType", "referenceId");

ALTER TABLE "CreditTransaction" ADD CONSTRAINT "CreditTransaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreditTransaction" ADD CONSTRAINT "CreditTransaction_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("jobId") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CreditAuditEvent" ADD CONSTRAINT "CreditAuditEvent_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CreditAuditEvent" ADD CONSTRAINT "CreditAuditEvent_creditTransactionId_fkey" FOREIGN KEY ("creditTransactionId") REFERENCES "CreditTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CreditAuditEvent" ADD CONSTRAINT "CreditAuditEvent_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("jobId") ON DELETE SET NULL ON UPDATE CASCADE;
