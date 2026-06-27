-- Drop maxBudgetUsd column from Job table (users should not cap their own costs)
ALTER TABLE "Job" DROP COLUMN "maxBudgetUsd";
