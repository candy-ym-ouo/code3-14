import type { GrowthStage, GrowthStageEventType } from '@balcony/shared';

/**
 * 生长阶段事件账本重放（纯函数）。
 *
 * 账本只追加、不删除：
 * - AUTO：证据推断建议，可被回退
 * - MANUAL：人工修正，写入即锁定；可被回退
 * - RELEASE：人工解除锁定（人工判断本身保留在历史中，只是不再生效）
 * - ROLLBACK：把目标 AUTO/MANUAL 标记为已作废，必须带原因；自身不可再被回退
 *
 * “生效阶段”始终由整段历史重放得出，而不是存储的某个当前值，
 * 因此任何回退都能完整还原当时的判断与原因链。
 */

export interface LedgerEvent {
  id: string;
  sequence: number;
  eventType: GrowthStageEventType;
  stage: GrowthStage | null;
  voidedAt: Date | null;
  createdAt: Date;
  targetEventId?: string | null;
}

export interface StageReplay<E extends LedgerEvent = LedgerEvent> {
  /** 最终生效阶段：锁定时来自人工修正，否则来自最近一条未作废的 AUTO */
  effectiveStage: GrowthStage | null;
  /** 产生生效阶段的那条事件 */
  effectiveEvent: E | null;
  source: 'MANUAL' | 'AUTO' | null;
  /** 是否处于人工锁定状态 */
  locked: boolean;
  /** 当前产生锁定的人工事件（可能不是最近一条 MANUAL：旧修正可能被回退） */
  lockingEvent: E | null;
  /** 最近一条未作废的 AUTO 事件（无论是否处于锁定） */
  latestAutoEvent: E | null;
  /** 被回退作废的事件 id 集合 */
  voidedIds: ReadonlySet<string>;
}

export function replayStageEvents<E extends LedgerEvent>(events: readonly E[]): StageReplay<E> {
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence || a.createdAt.getTime() - b.createdAt.getTime());
  const voidedByRollback = new Set<string>();
  for (const event of ordered) {
    if (event.eventType === 'ROLLBACK') {
      // ROLLBACK 指向的目标在 service 层已保证为 AUTO/MANUAL
      if (event.targetEventId) voidedByRollback.add(event.targetEventId);
    }
  }
  const voidedIds = new Set<string>();
  for (const event of ordered) {
    if (event.voidedAt || voidedByRollback.has(event.id)) voidedIds.add(event.id);
  }

  // MANUAL/RELEASE 像开关一样按顺序重放；被回退作废的 MANUAL 视为从未上锁
  let lockingEvent: E | null = null;
  let latestAutoEvent: E | null = null;
  for (const event of ordered) {
    if (voidedIds.has(event.id)) continue;
    if (event.eventType === 'MANUAL') lockingEvent = event;
    if (event.eventType === 'RELEASE') lockingEvent = null;
    if (event.eventType === 'AUTO') latestAutoEvent = event;
  }

  const effectiveEvent = lockingEvent ?? latestAutoEvent;
  return {
    effectiveStage: effectiveEvent?.stage ?? null,
    effectiveEvent,
    source: lockingEvent ? 'MANUAL' : latestAutoEvent ? 'AUTO' : null,
    locked: lockingEvent !== null,
    lockingEvent,
    latestAutoEvent,
    voidedIds,
  };
}
