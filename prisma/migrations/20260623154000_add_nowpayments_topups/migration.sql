-- Add provider-neutral NOWPayments invoice/payment metadata to prepaid top-up orders.
ALTER TABLE "PrepaidTopUpOrder"
  ADD COLUMN "providerInvoiceId" TEXT,
  ADD COLUMN "providerPaymentId" TEXT,
  ADD COLUMN "payCurrency" TEXT,
  ADD COLUMN "payAmount" DECIMAL(24, 12);

CREATE UNIQUE INDEX "PrepaidTopUpOrder_providerInvoiceId_key" ON "PrepaidTopUpOrder"("providerInvoiceId");
CREATE UNIQUE INDEX "PrepaidTopUpOrder_providerPaymentId_key" ON "PrepaidTopUpOrder"("providerPaymentId");
CREATE INDEX "PrepaidTopUpOrder_provider_providerInvoiceId_idx" ON "PrepaidTopUpOrder"("provider", "providerInvoiceId");
CREATE INDEX "PrepaidTopUpOrder_provider_providerPaymentId_idx" ON "PrepaidTopUpOrder"("provider", "providerPaymentId");
