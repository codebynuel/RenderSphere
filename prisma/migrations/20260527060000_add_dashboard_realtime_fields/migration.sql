-- Add updated timestamps, progress storage, safer upload sizing, and dashboard indexes.
ALTER TABLE "User" DROP COLUMN IF EXISTS "apiKeyHash";
ALTER TABLE "User" DROP COLUMN IF EXISTS "apiKeyUpdatedAt";
ALTER TABLE "User" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Project" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Job" ADD COLUMN "progress" JSONB;

ALTER TABLE "Upload" ALTER COLUMN "fileSizeBytes" TYPE BIGINT;

CREATE UNIQUE INDEX "AccessKey_tokenHash_key" ON "AccessKey"("tokenHash");
CREATE UNIQUE INDEX "Project_userId_name_key" ON "Project"("userId", "name");
CREATE INDEX "AccessKey_userId_idx" ON "AccessKey"("userId");
CREATE INDEX "Session_userId_idx" ON "Session"("userId");
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");
CREATE INDEX "Upload_userId_idx" ON "Upload"("userId");
CREATE INDEX "Upload_createdAt_idx" ON "Upload"("createdAt");
CREATE INDEX "Project_userId_idx" ON "Project"("userId");
CREATE INDEX "Job_userId_createdAt_idx" ON "Job"("userId", "createdAt");
CREATE INDEX "Job_userId_status_idx" ON "Job"("userId", "status");
CREATE INDEX "Job_projectId_idx" ON "Job"("projectId");
CREATE INDEX "Job_status_idx" ON "Job"("status");
