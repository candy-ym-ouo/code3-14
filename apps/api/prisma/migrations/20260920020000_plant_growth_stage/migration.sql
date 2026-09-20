-- CreateEnum
CREATE TYPE "GrowthStage" AS ENUM ('GERMINATION', 'VEGETATIVE', 'BUD', 'FLOWERING', 'FRUITING', 'DORMANT');

-- CreateEnum
CREATE TYPE "StageEventSource" AS ENUM ('AUTO_INFERRED', 'MANUAL_CORRECTION', 'ROLLBACK');

-- CreateEnum
CREATE TYPE "StageConfidence" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- CreateTable
CREATE TABLE "PlantStageEvent" (
    "id" TEXT NOT NULL,
    "plantId" TEXT NOT NULL,
    "stage" "GrowthStage" NOT NULL,
    "source" "StageEventSource" NOT NULL,
    "confidence" "StageConfidence",
    "validFrom" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "evidenceJson" JSONB NOT NULL DEFAULT '{}',
    "ruleVersion" TEXT,
    "supersededAt" TIMESTAMP(3),
    "supersededById" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "basedOnEventId" TEXT,

    CONSTRAINT "PlantStageEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlantStageEvent_plantId_validFrom_idx" ON "PlantStageEvent"("plantId", "validFrom" DESC);

-- CreateIndex
CREATE INDEX "PlantStageEvent_plantId_supersededAt_idx" ON "PlantStageEvent"("plantId", "supersededAt");

-- CreateIndex
CREATE INDEX "PlantStageEvent_plantId_createdAt_idx" ON "PlantStageEvent"("plantId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "PlantStageEvent" ADD CONSTRAINT "PlantStageEvent_plantId_fkey" FOREIGN KEY ("plantId") REFERENCES "Plant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlantStageEvent" ADD CONSTRAINT "PlantStageEvent_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlantStageEvent" ADD CONSTRAINT "PlantStageEvent_basedOnEventId_fkey" FOREIGN KEY ("basedOnEventId") REFERENCES "PlantStageEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlantStageEvent" ADD CONSTRAINT "PlantStageEvent_supersededById_fkey" FOREIGN KEY ("supersededById") REFERENCES "PlantStageEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
