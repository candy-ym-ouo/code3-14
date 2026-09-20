/**
 * 植物生长阶段服务：综合时间序列自动推断与人工修正，输出当前阶段。
 *
 * 不可变规则：
 * 1. 事件表（PlantStageEvent）只追加，任何更正都以新事件表达，旧事件仅标记 supersededAt。
 * 2. 自动推断（AUTO_INFERRED）可被随时重算、取代；但它永不覆盖人工判断
 *    （MANUAL_CORRECTION / ROLLBACK）。最近一条有效人工事件是「锚点」，
 *    自动推断只允许描述锚点之后的阶段推进。
 * 3. 回退（ROLLBACK）本身是一条新的人工事件，并记录目标事件、取代的事件和用户原因，
 *    与被回退事件的 basedOn 链共同构成可追溯的原因链。
 */
import { Prisma, type GrowthStage, type PlantStageEvent, type PrismaClient, type StageConfidence } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';
import { AppError } from '../lib/errors.js';
import {
  STAGE_RULE_VERSION,
  decideAutoStageUpdate,
  inferStage,
  isHumanStageSource,
  latestHumanAnchor,
  latestLiveStageEvent,
  type StageEvidence,
  type StageSignal,
} from './growth-stage-engine.js';

type Tx = Prisma.TransactionClient;

const EVIDENCE_WINDOW_LIMIT = 10_000;

async function loadPlant(tx: Tx, plantId: string) {
  const plant = await tx.plant.findFirst({
    where: { id: plantId, archivedAt: null },
    select: { id: true, workspaceId: true, acquiredAt: true },
  });
  if (!plant) throw new AppError(404, 'PLANT_NOT_FOUND', '植物不存在');
  return plant;
}

/** 该植物全部阶段事件（含已失效），按生效时间升序 */
async function loadEvents(tx: Tx, plantId: string): Promise<PlantStageEvent[]> {
  return tx.plantStageEvent.findMany({
    where: { plantId },
    orderBy: [{ validFrom: 'asc' }, { createdAt: 'asc' }],
  });
}

/** 当前生效事件：supersededAt 为空者中生效时间最新的一条 */
export function liveEvent(events: PlantStageEvent[]): PlantStageEvent | null {
  return latestLiveStageEvent(events) as PlantStageEvent | null;
}

/** 最近一条有效人工锚点（若存在） */
function latestAnchor(events: PlantStageEvent[]): PlantStageEvent | null {
  return latestHumanAnchor(events) as PlantStageEvent | null;
}

async function loadSignals(tx: Tx, plantId: string, from: Date, to: Date): Promise<StageSignal[]> {
  const [observations, actions] = await Promise.all([
    tx.observation.findMany({
      where: { plantId, deletedAt: null, observedAt: { gte: from, lt: to } },
      orderBy: { observedAt: 'asc' },
      take: EVIDENCE_WINDOW_LIMIT,
      select: { observedAt: true, plantTags: true, plantStatus: true },
    }),
    tx.actionLog.findMany({
      where: { plantId, deletedAt: null, startedAt: { gte: from, lt: to } },
      orderBy: { startedAt: 'asc' },
      take: EVIDENCE_WINDOW_LIMIT,
      select: { startedAt: true, actionType: true },
    }),
  ]);
  return [
    ...observations.map((item): StageSignal => ({
      at: item.observedAt,
      tags: item.plantTags,
      plantStatus: item.plantStatus,
    })),
    ...actions.map((item): StageSignal => ({ at: item.startedAt, actionType: item.actionType })),
  ];
}

async function createEvent(tx: Tx, data: {
  plantId: string;
  stage: GrowthStage;
  source: PlantStageEvent['source'];
  confidence: StageConfidence | null;
  validFrom: Date;
  reason: string;
  evidence: StageEvidence | Prisma.InputJsonValue;
  ruleVersion: string | null;
  createdBy: string;
  basedOnEventId?: string | null;
}): Promise<PlantStageEvent> {
  return tx.plantStageEvent.create({
    data: {
      plantId: data.plantId,
      stage: data.stage,
      source: data.source,
      confidence: data.confidence,
      validFrom: data.validFrom,
      reason: data.reason,
      evidenceJson: data.evidence as unknown as Prisma.InputJsonValue,
      ruleVersion: data.ruleVersion,
      createdBy: data.createdBy,
      basedOnEventId: data.basedOnEventId ?? null,
    },
  });
}

async function supersede(tx: Tx, eventId: string, supersededById: string, at = new Date()): Promise<void> {
  await tx.plantStageEvent.updateMany({
    where: { id: eventId, supersededAt: null },
    data: { supersededAt: at, supersededById },
  });
}

/**
 * 用最新时间序列证据重算植物阶段。
 *
 * - 无锚点时：推断覆盖全部历史，可在任意时间产生/更新自动事件。
 * - 有锚点时：仅推断锚点 validFrom 之后的推进；推断结果早于锚点或阶段与锚点相同
 *   都不会写入（绝不覆盖人工判断）。
 * - 重算幂等：推断与当前有效自动事件一致时只刷新证据，不制造新事件。
 */
export async function recomputePlantStage(
  plantId: string,
  options: { now?: Date; client?: PrismaClient } = {},
): Promise<{ changed: boolean; event: PlantStageEvent | null }> {
  const now = options.now ?? new Date();
  const client = options.client ?? defaultPrisma;
  return client.$transaction(async (tx) => {
    const plant = await loadPlant(tx, plantId);
    const events = await loadEvents(tx, plantId);
    const current = liveEvent(events);
    const anchor = latestAnchor(events);

    const windowStart = anchor ? anchor.validFrom : plant.acquiredAt ?? new Date('1970-01-01T00:00:00.000Z');
    const signals = await loadSignals(tx, plantId, windowStart, now);
    const inference = inferStage({ signals, windowStart, windowEnd: now, acquiredAt: plant.acquiredAt });
    const decision = decideAutoStageUpdate({ events, inference });

    if (decision.action === 'none') {
      return { changed: false, event: current };
    }

    if (decision.action === 'refresh') {
      const refreshed = await tx.plantStageEvent.update({
        where: { id: decision.eventId },
        data: {
          evidenceJson: inference.evidence as unknown as Prisma.InputJsonValue,
          confidence: inference.confidence,
          ruleVersion: STAGE_RULE_VERSION,
        },
      });
      return { changed: false, event: refreshed };
    }

    // append：旧自动事件标记失效（保留行与证据），追加新事件；人工事件绝不动
    const created = await createEvent(tx, {
      plantId,
      stage: decision.stage,
      source: 'AUTO_INFERRED',
      confidence: inference.confidence,
      validFrom: decision.validFrom,
      reason: decision.reason,
      evidence: inference.evidence,
      ruleVersion: STAGE_RULE_VERSION,
      createdBy: anchor?.createdBy ?? (await systemUserId(tx, plant.workspaceId)),
      basedOnEventId: decision.basedOnEventId ?? null,
    });
    if (decision.supersedeEventId) await supersede(tx, decision.supersedeEventId, created.id);
    return { changed: true, event: created };
  });
}

/** 无锚点的自动事件需要一个作者：取空间所有者（自动推断不属于任何具体操作人） */
async function systemUserId(tx: Tx, workspaceId: string): Promise<string> {
  const workspace = await tx.workspace.findUniqueOrThrow({
    where: { id: workspaceId },
    select: { ownerUserId: true },
  });
  return workspace.ownerUserId;
}

/** 人工修正：成为新锚点；取代当前生效的自动推断（若有），历史人工事件原样保留 */
export async function applyManualStageCorrection(input: {
  plantId: string;
  userId: string;
  stage: GrowthStage;
  validFrom?: Date;
  reason: string;
  now?: Date;
}): Promise<PlantStageEvent> {
  const now = input.now ?? new Date();
  const validFrom = input.validFrom ?? now;
  if (validFrom.getTime() > now.getTime() + 5 * 60_000) {
    throw new AppError(422, 'FUTURE_STAGE_DATE', '阶段生效时间不能晚于当前时间 5 分钟');
  }
  return defaultPrisma.$transaction(async (tx) => {
    await loadPlant(tx, input.plantId);
    const events = await loadEvents(tx, input.plantId);
    const current = liveEvent(events);
    if (current && isHumanStageSource(current.source) && current.stage === input.stage && Math.abs(current.validFrom.getTime() - validFrom.getTime()) < 60_000) {
      throw new AppError(409, 'STAGE_CORRECTION_DUPLICATE', '该阶段与当前人工判定一致，无需重复修正');
    }

    const anchor = latestAnchor(events);
    const event = await createEvent(tx, {
      plantId: input.plantId,
      stage: input.stage,
      source: 'MANUAL_CORRECTION',
      confidence: null,
      validFrom,
      reason: input.reason,
      evidence: {
        ruleVersion: STAGE_RULE_VERSION,
        manual: true,
        previousEventId: current?.id ?? null,
        note: '人工修正优先级高于自动推断；自动推断只在该锚点之后继续',
      },
      ruleVersion: null,
      createdBy: input.userId,
      basedOnEventId: anchor?.id ?? null,
    });

    // 仅取代当前生效的自动推断；人工事件（含更早的锚点）永不被覆盖
    if (current && current.source === 'AUTO_INFERRED') {
      await supersede(tx, current.id, event.id);
    }
    return event;
  });
}

/**
 * 回退到指定历史事件的阶段。回退不是删除：它产生一条 ROLLBACK 人工事件，
 * 记录目标事件（basedOn）、被取代的当前事件（supersededBy 反向指针）和用户原因，
 * 完整原因链可沿 basedOnEventId / supersededById 双向追溯。
 */
export async function rollbackPlantStage(input: {
  plantId: string;
  userId: string;
  eventId: string;
  reason: string;
  now?: Date;
}): Promise<PlantStageEvent> {
  const now = input.now ?? new Date();
  return defaultPrisma.$transaction(async (tx) => {
    await loadPlant(tx, input.plantId);
    const target = await tx.plantStageEvent.findFirst({ where: { id: input.eventId, plantId: input.plantId } });
    if (!target) throw new AppError(404, 'STAGE_EVENT_NOT_FOUND', '阶段事件不存在');

    const events = await loadEvents(tx, input.plantId);
    const current = liveEvent(events);
    if (current && current.id === target.id) {
      throw new AppError(409, 'STAGE_ROLLBACK_CURRENT', '该事件就是当前生效阶段，无需回退');
    }

    const rollback = await createEvent(tx, {
      plantId: input.plantId,
      stage: target.stage,
      source: 'ROLLBACK',
      confidence: null,
      validFrom: now,
      reason: input.reason,
      evidence: {
        manual: true,
        rollbackToEventId: target.id,
        rollbackToSource: target.source,
        rollbackToStage: target.stage,
        targetValidFrom: target.validFrom.toISOString(),
        targetReason: target.reason,
        previousEventId: current?.id ?? null,
        note: '回退为人工判定锚点；被回退事件及其证据保留，自动推断不得覆盖本事件',
      },
      ruleVersion: null,
      createdBy: input.userId,
      basedOnEventId: target.id,
    });
    if (current) await supersede(tx, current.id, rollback.id);
    return rollback;
  });
}

export async function getPlantStageTimeline(plantId: string): Promise<{
  current: PlantStageEvent | null;
  anchor: PlantStageEvent | null;
  events: PlantStageEvent[];
}> {
  const events = await defaultPrisma.plantStageEvent.findMany({
    where: { plantId },
    orderBy: [{ validFrom: 'desc' }, { createdAt: 'desc' }],
  });
  const orderedAsc = [...events].sort((a, b) => a.validFrom.getTime() - b.validFrom.getTime());
  return {
    current: liveEvent(orderedAsc),
    anchor: latestAnchor(orderedAsc),
    events,
  };
}
