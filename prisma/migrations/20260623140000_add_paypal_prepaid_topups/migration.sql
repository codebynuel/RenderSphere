-- Add PayPal prepaid top-up order records for order status, capture idempotency, and recharge history.
CREATE TABLE "PrepaidTopUpOrder" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'PAYPAL',
    "providerOrderId" TEXT NOT NULL,
    "providerCaptureId" TEXT,
    "packageId" TEXT NOT NULL,
    "amountUsd" DECIMAL(12,6) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" TEXT NOT NULL DEFAULT 'CREATED',
    "providerStatus" TEXT,
    "approvalUrl" TEXT,
    "creditTransactionId" TEXT,
    "failureReason" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "capturedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),

    CONSTRAINT "PrepaidTopUpOrder_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PrepaidTopUpOrder_providerOrderId_key" ON "PrepaidTopUpOrder"("providerOrderId");
CREATE UNIQUE INDEX "PrepaidTopUpOrder_providerCaptureId_key" ON "PrepaidTopUpOrder"("providerCaptureId");
CREATE UNIQUE INDEX "PrepaidTopUpOrder_creditTransactionId_key" ON "PrepaidTopUpOrder"("creditTransactionId");
CREATE INDEX "PrepaidTopUpOrder_userId_createdAt_idx" ON "PrepaidTopUpOrder"("userId", "createdAt");
CREATE INDEX "PrepaidTopUpOrder_userId_status_idx" ON "PrepaidTopUpOrder"("userId", "status");
CREATE INDEX "PrepaidTopUpOrder_provider_providerOrderId_idx" ON "PrepaidTopUpOrder"("provider", "providerOrderId");

ALTER TABLE "PrepaidTopUpOrder" ADD CONSTRAINT "PrepaidTopUpOrder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PrepaidTopUpOrder" ADD CONSTRAINT "PrepaidTopUpOrder_creditTransactionId_fkey" FOREIGN KEY ("creditTransactionId") REFERENCES "CreditTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
