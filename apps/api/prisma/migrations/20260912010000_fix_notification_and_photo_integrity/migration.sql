DROP INDEX IF EXISTS "Photo_workspaceId_sha256_key";
CREATE INDEX "Photo_workspaceId_sha256_idx" ON "Photo"("workspaceId", "sha256");

ALTER TABLE "Notification" ADD COLUMN "dedupeKey" TEXT;
CREATE UNIQUE INDEX "Notification_dedupeKey_key" ON "Notification"("dedupeKey");


ALTER TABLE "ReminderOccurrence" ADD COLUMN "deliveryVersion" INTEGER NOT NULL DEFAULT 0;
