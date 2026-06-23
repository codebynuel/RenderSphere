-- Add an explicit top-up source while keeping existing package orders intact.
ALTER TABLE "PrepaidTopUpOrder"
  ADD COLUMN "topUpType" TEXT NOT NULL DEFAULT 'PACKAGE';

ALTER TABLE "PrepaidTopUpOrder"
  ALTER COLUMN "packageId" DROP NOT NULL;

CREATE INDEX "PrepaidTopUpOrder_userId_topUpType_idx" ON "PrepaidTopUpOrder"("userId", "topUpType");
