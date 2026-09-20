import { Prisma, type GrowthStage } from '@prisma/client';
import { prisma } from '../db.js';
import { AppError } from '../lib/errors.js';
import { workspaceIdForPlant } from './authorization.js';
import {
  GROWTH_STAGE_ENGINE_VERSION,
  growthInputFingerprint,
  inferGrowthStage,
  type GrowthStageEngineInput,
  type GrowthStageInference,
} from './growth-stage-engine.js';
import { replayStageEvents, type LedgerEvent } from './growth-stage-ledger.js';

/**
 * 植物生长阶段模块：时间序列证据（可重算、可覆盖） + 人工修正（只追加、不可覆盖）。
 *
 * 分层规则：
 * 1. PlantGrowthEvidence 是证据层，任何时候都可重新计算并覆盖；
 * 2. PlantGrowthStageEvent 是判断层账本，只追加；MANUAL 锁定后证据重算不得改变生效阶段；
 * 3. 回退不删除任何事件：追加 ROLLBACK（必带原因）并把目标事件标记 voided，阶段由账本重放得出。
 */

/** 冻结在事件里的原因链结构。事后证据重算不会改写已落库的快照。 */
export interface StageEventReasonChain {
  evidenceSnapshot?: GrowthStageInference | null;
  evidenceFingerprint?: string;
  effectiveEventIds: string[];
  targetEventId?: string | null;
  targetSnapshot?: {
    id: string;
    sequence: number;
    eventType: string;
    stage: GrowthStage | null;
    reason: string;
  } | null;
  note: string;
}

export interface GrowthStageState {
  plantId: string;
  stage: GrowthStage | null;
  source: 'MANUAL' | 'AUTO' | null;
  locked: boolean;
  evidence: {
    inferredStage: GrowthStage;
    confidence: number;
    scores: Record<string, number>;
    signals: GrowthStageInference['signals'];
    engineVersion: string;
    fingerprint: string;
    inferredFromDataAt: string | null;
    computedAt: string;
    stale: boolean;
    /** 当前证据指纹曾被人工回退拒绝；出现新证据前不会据此自动生成 AUTO */
    suppressedByRollback: boolean;
  } | null;
  effectiveEvent: SerializedStageEvent | null;
  lockingEvent: SerializedStageEvent | null;
  /** 生效所依据的完整事件链（含被回退作废标记），用于追溯原因 */
  reasonChain: SerializedStageEvent[];
  rollbackHistory: SerializedStageEvent[];
}

export interface SerializedStageEvent {
  id: string;
  sequence: number;
  eventType: 'AUTO' | 'MANUAL' | 'RELEASE' | 'ROLLBACK';
  stage: GrowthStage | null;
  reason: string;
  reasonChain: StageEventReasonChain;
  locked: boolean;
  targetEventId: string | null;
  voided: boolean;
  createdBy: string | null;
  createdAt: string;
}

function serializeEvent(
  event: {
    id: string;
    sequence: number;
    eventType: 'AUTO' | 'MANUAL' | 'RELEASE' | 'ROLLBACK';
    stage: GrowthStage | null;
    reason: string;
    reasonChainJson: Prisma.JsonValue;
    locked: boolean;
    targetEventId: string | null;
    voidedAt: Date | null;
    createdBy: string | null;
    createdAt: Date;
  },
): SerializedStageEvent {
  return {
    id: event.id,
    sequence: event.sequence,
    eventType: event.eventType,
    stage: event.stage,
    reason: event.reason,
    reasonChain: event.reasonChainJson as unknown as StageEventReasonChain,
    locked: event.locked,
    targetEventId: event.targetEventId,
    voided: event.voidedAt !== null,
    createdBy: event.createdBy,
    createdAt: event.createdAt.toISOString(),
  };
}

async function assertPlantEditable(plantId: string, userId: string) {
  const workspaceId = await workspaceIdForPlant(plantId, userId, 'EDITOR');
  const plant = await prisma.plant.findFirst({
    where: { id: plantId, archivedAt: null },
    select: { id: true },
  });
  if (!plant) throw new AppError(409, 'PLANT_ARCHIVED', '已归档植物不能修改生长阶段');
  return workspaceId;
}

async function buildEngineInput(plantId: string): Promise<{
  input: GrowthStageEngineInput;
  latestDataAt: Date | null;
}> {
  const plant = await prisma.plant.findUnique({
    where: { id: plantId },
    select: { acquiredAt: true },
  });
  if (!plant) throw new AppError(404, 'PLANT_NOT_FOUND', '植物不存在');

  const [observations, actions] = await Promise.all([
    prisma.observation.findMany({
      where: { plantId, deletedAt: null },
      orderBy: { observedAt: 'asc' },
      select: { id: true, observedAt: true, plantTags: true, plantStatus: true },
      take: 10_000,
    }),
    prisma.actionLog.findMany({
      where: { plantId, deletedAt: null },
      orderBy: { startedAt: 'asc' },
      select: { id: true, startedAt: true, actionType: true },
      take: 10_000,
    }),
  ]);

  const latestDataAt =
    [observations.at(-1)?.observedAt, actions.at(-1)?.startedAt]
      .filter((value): value is Date => value instanceof Date)
      .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;

  return {
    input: {
      observations: observations.map((item) => ({
        id: item.id,
        observedAt: item.observedAt,
        plantTags: item.plantTags,
        plantStatus: item.plantStatus,
      })),
      actions: actions.map((item) => ({
        id: item.id,
        startedAt: item.startedAt,
        actionType: item.actionType,
      })),
      acquiredAt: plant.acquiredAt,
    },
    latestDataAt,
  };
}

async function listEvents(plantId: string) {
  return prisma.plantGrowthStageEvent.findMany({
    where: { plantId },
    orderBy: [{ sequence: 'asc' }],
  });
}

/**
 * 重新计算证据层（可安全重复调用：允许覆盖证据行）。
 * - persist=false 只返回本次重算结果，不落库（GET 预览用）；
 * - persist=true 覆盖证据行；当人工未锁定且推断阶段相对最近 AUTO 发生变化时，追加 AUTO 事件。
 */
export async function recomputeGrowthEvidence(
  plantId: string,
  options: { persist: boolean; now?: Date } = { persist: true },
) {
  const now = options.now ?? new Date();
  const { input, latestDataAt } = await buildEngineInput(plantId);
  const inference = inferGrowthStage(input, now);
  const fingerprint = growthInputFingerprint(input, now);

  if (!options.persist) {
    const [stored, persistedEvents] = await Promise.all([
      prisma.plantGrowthEvidence.findUnique({ where: { plantId } }),
      listEvents(plantId),
    ]);
    const rejectedFingerprints = new Set<string>();
    for (const event of persistedEvents) {
      if (event.eventType !== 'AUTO' || !event.voidedAt) continue;
      const chain = event.reasonChainJson as unknown as StageEventReasonChain | null;
      if (chain?.evidenceFingerprint) rejectedFingerprints.add(chain.evidenceFingerprint);
    }
    return {
      inference,
      fingerprint,
      storedFingerprint: stored?.inputFingerprint ?? null,
      storedComputedAt: stored?.computedAt ?? null,
      stale: stored ? stored.inputFingerprint !== fingerprint : true,
      suppressedByRollback: rejectedFingerprints.has(fingerprint),
    };
  }

  const plant = await prisma.plant.findUniqueOrThrow({
    where: { id: plantId },
    select: { workspaceId: true },
  });
  const events = await listEvents(plantId);
  const replay = replayStageEvents(events);

  const evidence = await prisma.plantGrowthEvidence.upsert({
    where: { plantId },
    create: {
      plantId,
      workspaceId: plant.workspaceId,
      inferredStage: inference.stage,
      confidence: inference.confidence,
      scoresJson: inference.scores as unknown as Prisma.InputJsonValue,
      signalsJson: inference.signals as unknown as Prisma.InputJsonValue,
      inputFingerprint: fingerprint,
      engineVersion: inference.engineVersion,
      inferredFromDataAt: latestDataAt,
    },
    update: {
      inferredStage: inference.stage,
      confidence: inference.confidence,
      scoresJson: inference.scores as unknown as Prisma.InputJsonValue,
      signalsJson: inference.signals as unknown as Prisma.InputJsonValue,
      inputFingerprint: fingerprint,
      engineVersion: inference.engineVersion,
      inferredFromDataAt: latestDataAt,
    },
  });

  let appendedAutoEvent: { id: string; sequence: number } | null = null;
  let suppressedByRollback = false;
  // 人工判断锁定期间：证据照常覆盖，但绝不允许 AUTO 改变生效阶段；
  // 未锁定时，仅当证据指纹相对最近一条 AUTO 发生变化、且推断阶段改变，才追加 AUTO。
  // 此外，同一证据指纹只要曾被人工回退拒绝，在出现新证据（指纹变化）前不再自动生成同结论。
  if (!replay.locked) {
    const rejectedFingerprints = new Set<string>();
    for (const event of events) {
      if (event.eventType !== 'AUTO' || !event.voidedAt) continue;
      const chain = event.reasonChainJson as unknown as StageEventReasonChain | null;
      if (chain?.evidenceFingerprint) rejectedFingerprints.add(chain.evidenceFingerprint);
    }
    const lastAutoFingerprint =
      replay.latestAutoEvent === null
        ? null
        : ((replay.latestAutoEvent as unknown as { reasonChainJson?: StageEventReasonChain | null })
            .reasonChainJson)?.evidenceFingerprint ?? null;
    const evidenceChanged = replay.latestAutoEvent === null || lastAutoFingerprint !== fingerprint;
    suppressedByRollback = rejectedFingerprints.has(fingerprint);
    const shouldAppendAuto =
      evidenceChanged &&
      !suppressedByRollback &&
      (replay.latestAutoEvent === null
        ? inference.stage !== 'UNKNOWN'
        : replay.latestAutoEvent.stage !== inference.stage);
    if (shouldAppendAuto) {
      const created = await appendStageEvent(plantId, plant.workspaceId, {
        eventType: 'AUTO',
        stage: inference.stage,
        reason:
          inference.stage === 'UNKNOWN'
            ? '证据不足，推断结果重置为未知'
            : `时间序列证据推断为 ${inference.stage}（置信度 ${inference.confidence}）`,
        locked: false,
        createdBy: null,
        reasonChain: {
          evidenceSnapshot: inference,
          evidenceFingerprint: fingerprint,
          effectiveEventIds: replay.effectiveEvent ? [replay.effectiveEvent.id] : [],
          note: '基于观察标签、健康状态与操作记录自动推断',
        },
      });
      appendedAutoEvent = { id: created.id, sequence: created.sequence };
    }
  }

  return {
    inference,
    fingerprint,
    storedFingerprint: fingerprint,
    storedComputedAt: evidence.computedAt,
    stale: false,
    evidence,
    locked: replay.locked,
    appendedAutoEvent,
    suppressedByRollback,
  };
}

interface AppendEventInput {
  eventType: 'AUTO' | 'MANUAL' | 'RELEASE' | 'ROLLBACK';
  stage: GrowthStage | null;
  reason: string;
  locked: boolean;
  createdBy: string | null;
  reasonChain: StageEventReasonChain;
  targetEventId?: string | null;
  voidTargetId?: string | null;
}

/** 追加账本事件，sequence 按植物严格递增；并发冲突时重试。 */
async function appendStageEvent(
  plantId: string,
  workspaceId: string,
  data: AppendEventInput,
): Promise<{ id: string; sequence: number }> {
  const maxAttempts = 5;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const created = await prisma.$transaction(async (tx) => {
        const last = await tx.plantGrowthStageEvent.findFirst({
          where: { plantId },
          orderBy: { sequence: 'desc' },
          select: { sequence: true },
        });
        const event = await tx.plantGrowthStageEvent.create({
          data: {
            plantId,
            workspaceId,
            sequence: (last?.sequence ?? 0) + 1,
            eventType: data.eventType,
            stage: data.stage,
            reason: data.reason,
            reasonChainJson: data.reasonChain as unknown as Prisma.InputJsonValue,
            locked: data.locked,
            targetEventId: data.targetEventId ?? null,
            createdBy: data.createdBy,
          },
          select: { id: true, sequence: true },
        });
        if (data.voidTargetId) {
          await tx.plantGrowthStageEvent.update({
            where: { id: data.voidTargetId },
            data: { voidedAt: new Date(), voidedByEventId: event.id },
          });
        }
        return event;
      });
      return created;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002' &&
        attempt < maxAttempts - 1
      ) {
        continue;
      }
      throw error;
    }
  }
  throw new AppError(409, 'STAGE_EVENT_CONFLICT', '生长阶段事件写入冲突，请重试');
}

/** 人工修正：写入即锁定，证据之后只能重算、不能覆盖。 */
export async function overrideGrowthStage(
  plantId: string,
  userId: string,
  input: { stage: Exclude<GrowthStage, 'UNKNOWN'>; reason: string },
) {
  const workspaceId = await assertPlantEditable(plantId, userId);
  // 先在内存中重算，避免在 MANUAL 落库前抢先产生一条 AUTO 事件
  const { inference, fingerprint } = await recomputeGrowthEvidence(plantId, { persist: false });

  const events = await listEvents(plantId);
  const replay = replayStageEvents(events);
  const created = await appendStageEvent(plantId, workspaceId, {
    eventType: 'MANUAL',
    stage: input.stage,
    reason: input.reason,
    locked: true,
    createdBy: userId,
    reasonChain: {
      evidenceSnapshot: inference,
      evidenceFingerprint: fingerprint,
      effectiveEventIds: replay.effectiveEvent ? [replay.effectiveEvent.id] : [],
      note:
        replay.locked && replay.lockingEvent
          ? `人工修正覆盖此前的人工判断（事件 #${replay.lockingEvent.sequence}）；证据仍持续重算但不生效`
          : '人工修正覆盖自动推断并锁定；证据仍持续重算但不生效',
    },
  });

  // MANUAL 已锁定：持久化只覆盖证据行，不会产生 AUTO
  await recomputeGrowthEvidence(plantId, { persist: true });
  return getGrowthStageState(plantId, userId, { persistEvidence: false, anchorEventId: created.id });
}

/** 人工解除锁定：恢复由证据决定阶段（人工判断保留在历史中）。 */
export async function releaseGrowthStage(
  plantId: string,
  userId: string,
  input: { reason: string },
) {
  const workspaceId = await assertPlantEditable(plantId, userId);
  const eventsBefore = await listEvents(plantId);
  const replayBefore = replayStageEvents(eventsBefore);
  if (!replayBefore.locked || !replayBefore.lockingEvent) {
    throw new AppError(409, 'STAGE_NOT_LOCKED', '当前没有生效中的人工修正，无需解除');
  }

  const { inference, fingerprint } = await recomputeGrowthEvidence(plantId, { persist: false });
  const release = await appendStageEvent(plantId, workspaceId, {
    eventType: 'RELEASE',
    stage: null,
    reason: input.reason,
    locked: false,
    createdBy: userId,
    targetEventId: replayBefore.lockingEvent.id,
    reasonChain: {
      evidenceSnapshot: inference,
      evidenceFingerprint: fingerprint,
      effectiveEventIds: [replayBefore.lockingEvent.id],
      targetEventId: replayBefore.lockingEvent.id,
      targetSnapshot: {
        id: replayBefore.lockingEvent.id,
        sequence: replayBefore.lockingEvent.sequence,
        eventType: replayBefore.lockingEvent.eventType,
        stage: replayBefore.lockingEvent.stage,
        reason: replayBefore.lockingEvent.reason,
      },
      note: '人工解除锁定，恢复以证据推断为准；被解除的人工判断保留在原因链中',
    },
  });

  // 解锁后立刻让证据落定为 AUTO 事件（若与最近 AUTO 不同）
  const { appendedAutoEvent } = await recomputeGrowthEvidence(plantId, { persist: true });
  return getGrowthStageState(plantId, userId, {
    persistEvidence: false,
    anchorEventId: appendedAutoEvent?.id ?? release.id,
  });
}

/**
 * 回退一条 AUTO/MANUAL 事件：不删除数据，只标记作废并追加带原因的 ROLLBACK。
 * 生效阶段由账本重新重放得出，完整原因链始终保留。
 */
export async function rollbackGrowthStage(
  plantId: string,
  userId: string,
  input: { targetEventId: string; reason: string },
) {
  const workspaceId = await assertPlantEditable(plantId, userId);
  // 内存重算冻结证据快照，避免在 ROLLBACK 落库前抢先产生 AUTO
  const { inference, fingerprint } = await recomputeGrowthEvidence(plantId, { persist: false });

  const events = await listEvents(plantId);
  const replayBefore = replayStageEvents(events);
  const target = events.find((event) => event.id === input.targetEventId);
  if (!target) throw new AppError(404, 'STAGE_EVENT_NOT_FOUND', '目标生长阶段事件不存在');
  if (target.eventType === 'ROLLBACK') {
    throw new AppError(422, 'ROLLBACK_TARGET_INVALID', '回退事件本身不能再被回退');
  }
  if (target.eventType === 'RELEASE') {
    throw new AppError(422, 'ROLLBACK_TARGET_INVALID', '解除锁定事件不能回退；如需重新锁定请直接提交人工修正');
  }
  if (replayBefore.voidedIds.has(target.id)) {
    throw new AppError(409, 'STAGE_EVENT_VOIDED', '目标事件已被回退作废');
  }

  const created = await appendStageEvent(plantId, workspaceId, {
    eventType: 'ROLLBACK',
    stage: null,
    reason: input.reason,
    locked: false,
    createdBy: userId,
    targetEventId: target.id,
    voidTargetId: target.id,
    reasonChain: {
      evidenceSnapshot: inference,
      evidenceFingerprint: fingerprint,
      effectiveEventIds: replayBefore.effectiveEvent ? [replayBefore.effectiveEvent.id, target.id] : [target.id],
      targetEventId: target.id,
      targetSnapshot: {
        id: target.id,
        sequence: target.sequence,
        eventType: target.eventType,
        stage: target.stage,
        reason: target.reason,
      },
      note: '回退作废目标事件并保留其原因快照；生效阶段由事件账本重新重放',
    },
  });

  // 回退后重放一次：若证据指纹未变，该结论已被人工拒绝而被抑制，保持回退后的阶段；
  // 若已出现新证据，则追加 AUTO 让证据重新主导。
  const after = await recomputeGrowthEvidence(plantId, { persist: true });
  return getGrowthStageState(plantId, userId, {
    persistEvidence: false,
    anchorEventId: after.appendedAutoEvent?.id ?? created.id,
  });
}

/** 组装对外状态：生效阶段 + 证据（含与人工判断的分歧）+ 完整原因链。 */
export async function getGrowthStageState(
  plantId: string,
  userId: string,
  options: { persistEvidence?: boolean; anchorEventId?: string } = {},
): Promise<GrowthStageState & { anchorEventId?: string }> {
  await workspaceIdForPlant(plantId, userId, 'VIEWER');

  const persistEvidence = options.persistEvidence ?? false;
  const recompute = await recomputeGrowthEvidence(plantId, { persist: persistEvidence });
  const events = await listEvents(plantId);
  const replay = replayStageEvents(events);
  const findEvent = (event: LedgerEvent | null) => events.find((item) => item.id === event?.id) ?? null;

  return {
    plantId,
    stage: replay.effectiveStage,
    source: replay.source,
    locked: replay.locked,
    evidence: {
      inferredStage: recompute.inference.stage,
      confidence: recompute.inference.confidence,
      scores: recompute.inference.scores,
      signals: recompute.inference.signals,
      engineVersion: GROWTH_STAGE_ENGINE_VERSION,
      fingerprint: recompute.fingerprint,
      inferredFromDataAt: recompute.inference.dataTo,
      computedAt: (recompute.storedComputedAt ?? new Date()).toISOString(),
      stale: recompute.stale,
      suppressedByRollback: recompute.suppressedByRollback,
    },
    effectiveEvent: (() => {
      const event = findEvent(replay.effectiveEvent);
      return event ? serializeEvent(event) : null;
    })(),
    lockingEvent: (() => {
      const event = findEvent(replay.lockingEvent);
      return event ? serializeEvent(event) : null;
    })(),
    reasonChain: events
      .filter((event) => !replay.voidedIds.has(event.id))
      .map(serializeEvent),
    rollbackHistory: events
      .filter((event) => event.eventType === 'ROLLBACK')
      .map(serializeEvent),
    ...(options.anchorEventId ? { anchorEventId: options.anchorEventId } : {}),
  };
}

/** 事件历史（含已作废事件），分页按时间倒序。 */
export async function listGrowthStageHistory(plantId: string, userId: string, limit: number, cursor?: string) {
  await workspaceIdForPlant(plantId, userId, 'VIEWER');
  const rows = await prisma.plantGrowthStageEvent.findMany({
    where: { plantId },
    orderBy: [{ sequence: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const hasMore = rows.length > limit;
  const items = (hasMore ? rows.slice(0, limit) : rows).map(serializeEvent);
  return { items, nextCursor: hasMore ? items.at(-1)?.id ?? null : null };
}

/** 供工作线程在观察/操作数据变化后调用：重算证据，必要时追加 AUTO。 */
export async function recomputeForPlant(plantId: string) {
  const plant = await prisma.plant.findFirst({
    where: { id: plantId, archivedAt: null },
    select: { id: true },
  });
  if (!plant) return null;
  return recomputeGrowthEvidence(plantId, { persist: true });
}
