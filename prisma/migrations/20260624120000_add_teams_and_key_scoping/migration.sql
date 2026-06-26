-- Add teams, key scoping, project members, and missing user/auth fields

-- User additions: name, email verification, password reset
ALTER TABLE "User" ADD COLUMN "name" TEXT;
ALTER TABLE "User" ADD COLUMN "emailVerifiedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "emailVerificationToken" TEXT;
ALTER TABLE "User" ADD COLUMN "passwordResetToken" TEXT;
ALTER TABLE "User" ADD COLUMN "passwordResetExpiresAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "User_emailVerificationToken_key" ON "User"("emailVerificationToken");
CREATE UNIQUE INDEX "User_passwordResetToken_key" ON "User"("passwordResetToken");

-- AccessKey additions: scope, budget, expiry
ALTER TABLE "AccessKey" ADD COLUMN "scopeType" TEXT NOT NULL DEFAULT 'GLOBAL';
ALTER TABLE "AccessKey" ADD COLUMN "scopeProjectId" TEXT;
ALTER TABLE "AccessKey" ADD COLUMN "budgetCapUsd" DECIMAL(12,6);
ALTER TABLE "AccessKey" ADD COLUMN "budgetSpentUsd" DECIMAL(12,6) DEFAULT 0;
ALTER TABLE "AccessKey" ADD COLUMN "expiresAt" TIMESTAMP(3);
CREATE INDEX "AccessKey_scopeProjectId_idx" ON "AccessKey"("scopeProjectId");
ALTER TABLE "AccessKey" ADD CONSTRAINT "AccessKey_scopeProjectId_fkey" FOREIGN KEY ("scopeProjectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Job additions: accessKeyId
ALTER TABLE "Job" ADD COLUMN "accessKeyId" TEXT;
ALTER TABLE "Job" ADD COLUMN "notificationSent" BOOLEAN NOT NULL DEFAULT false;

-- Create Team table (MUST be before Project FK references it)
CREATE TABLE "Team" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Team_ownerId_idx" ON "Team"("ownerId");
ALTER TABLE "Team" ADD CONSTRAINT "Team_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Project additions: teamId, visibility (after Team exists)
ALTER TABLE "Project" ADD COLUMN "teamId" TEXT;
ALTER TABLE "Project" ADD COLUMN "visibility" TEXT NOT NULL DEFAULT 'PRIVATE';
CREATE INDEX "Project_teamId_idx" ON "Project"("teamId");
ALTER TABLE "Project" ADD CONSTRAINT "Project_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Create TeamMember table
CREATE TABLE "TeamMember" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'MEMBER',
    "budgetCapUsd" DECIMAL(12,6),
    "invitedBy" TEXT,
    "invitedEmail" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TeamMember_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TeamMember_teamId_userId_key" ON "TeamMember"("teamId", "userId");
CREATE INDEX "TeamMember_teamId_idx" ON "TeamMember"("teamId");
CREATE INDEX "TeamMember_userId_idx" ON "TeamMember"("userId");
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Create ProjectMember table
CREATE TABLE "ProjectMember" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'VIEWER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProjectMember_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ProjectMember_projectId_userId_key" ON "ProjectMember"("projectId", "userId");
CREATE INDEX "ProjectMember_projectId_idx" ON "ProjectMember"("projectId");
CREATE INDEX "ProjectMember_userId_idx" ON "ProjectMember"("userId");
ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Create TeamInviteLink table
CREATE TABLE "TeamInviteLink" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'MEMBER',
    "maxUses" INTEGER,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TeamInviteLink_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TeamInviteLink_token_key" ON "TeamInviteLink"("token");
CREATE INDEX "TeamInviteLink_teamId_idx" ON "TeamInviteLink"("teamId");
CREATE INDEX "TeamInviteLink_token_idx" ON "TeamInviteLink"("token");
ALTER TABLE "TeamInviteLink" ADD CONSTRAINT "TeamInviteLink_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Create TeamActivity table
CREATE TABLE "TeamActivity" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "actorId" TEXT,
    "actorEmail" TEXT,
    "action" TEXT NOT NULL,
    "targetId" TEXT,
    "targetEmail" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TeamActivity_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "TeamActivity_teamId_createdAt_idx" ON "TeamActivity"("teamId", "createdAt");
ALTER TABLE "TeamActivity" ADD CONSTRAINT "TeamActivity_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
