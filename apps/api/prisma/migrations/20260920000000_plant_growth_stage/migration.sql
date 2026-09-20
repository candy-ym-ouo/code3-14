-- CreateEnum
CREATE TYPE "GrowthStage" AS ENUM ('UNKNOWN', 'SEEDLING', 'VEGETATIVE', 'BUD', 'FLOWERING', 'FRUITING', 'SENESCENCE', 'DORMANT');

-- CreateEnum
CREATE TYPE "GrowthStageEventType" AS ENUM ('AUTO', 'MANUAL', 'RELEASE', 'ROLLBACK');

-- CreateTable: 证据层（可重算、可覆盖）
CREATE TABLE "PlantGrowthEvidence" (
    "id" TEXT NOT NULL,
    "plantId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "inferredStage" "GrowthStage" NOT NULL,
    "confidence" DECIMAL(5,4) NOT NULL,
    "scoresJson" JSONB NOT NULL,
    "signalsJson" JSONB NOT NULL,
    "inputFingerprint" TEXT NOT NULL,
    "engineVersion" TEXT NOT NULL,
    "inferredFromDataAt" TIMESTAMP(3),
    "computedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlantGrowthEvidence_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlantGrowthEvidence_plantId_key" ON "PlantGrowthEvidence"("plantId");
CREATE INDEX "PlantGrowthEvidence_workspaceId_idx" ON "PlantGrowthEvidence"("workspaceId");

-- CreateTable: 判断层（只追加事件账本）
CREATE TABLE "PlantGrowthStageEvent" (
    "id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "plantId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "eventType" "GrowthStageEventType" NOT NULL,
    "stage" "GrowthStage",
    "reason" TEXT NOT NULL,
    "reasonChainJson" JSONB NOT NULL,
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "targetEventId" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidedByEventId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlantGrowthStageEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlantGrowthStageEvent_plantId_sequence_key" ON "PlantGrowthStageEvent"("plantId", "sequence");
CREATE INDEX "PlantGrowthStageEvent_workspaceId_createdAt_idx" ON "PlantGrowthStageEvent"("workspaceId", "createdAt" DESC);
CREATE INDEX "PlantGrowthStageEvent_plantId_createdAt_idx" ON "PlantGrowthStageEvent"("plantId", "createdAt");
CREATE INDEX "PlantGrowthStageEvent_targetEventId_idx" ON "PlantGrowthStageEvent"("targetEventId");

-- AddForeignKey
ALTER TABLE "PlantGrowthEvidence" ADD CONSTRAINT "PlantGrowthEvidence_plantId_fkey" FOREIGN KEY ("plantId") REFERENCES "Plant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PlantGrowthStageEvent" ADD CONSTRAINT "PlantGrowthStageEvent_plantId_fkey" FOREIGN KEY ("plantId") REFERENCES "Plant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PlantGrowthStageEvent" ADD CONSTRAINT "PlantGrowthStageEvent_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PlantGrowthStageEvent" ADD CONSTRAINT "PlantGrowthStageEvent_targetEventId_fkey" FOREIGN KEY ("targetEventId") REFERENCES "PlantGrowthStageEvent"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "PlantGrowthStageEvent" ADD CONSTRAINT "PlantGrowthStageEvent_voidedByEventId_fkey" FOREIGN KEY ("voidedByEventId") REFERENCES "PlantGrowthStageEvent"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
