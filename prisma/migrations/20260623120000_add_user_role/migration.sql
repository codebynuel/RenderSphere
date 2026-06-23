-- Add role column to User model
ALTER TABLE "User" ADD COLUMN "role" TEXT NOT NULL DEFAULT 'user';
