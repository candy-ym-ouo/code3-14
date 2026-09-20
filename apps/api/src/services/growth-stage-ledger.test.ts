import type { GrowthStage, GrowthStageEventType } from '@balcony/shared';
import { describe, expect, it } from 'vitest';
import { replayStageEvents, type LedgerEvent } from './growth-stage-ledger.js';

let counter = 0;
function event(
  sequence: number,
  eventType: GrowthStageEventType,
  stage: GrowthStage | null,
  extra: Partial<LedgerEvent> = {},
): LedgerEvent {
  counter += 1;
  return {
    id: `e${counter}`,
    sequence,
    eventType,
    stage,
    targetEventId: null,
    voidedAt: null,
    createdAt: new Date(Date.parse('2026-09-01') + sequence * 1000),
    ...extra,
  };
}

describe('replayStageEvents', () => {
  it('returns null state for an empty ledger', () => {
    const replay = replayStageEvents([]);
    expect(replay.effectiveStage).toBeNull();
    expect(replay.locked).toBe(false);
  });

  it('uses the latest non-voided AUTO when unlocked', () => {
    const replay = replayStageEvents([
      event(1, 'AUTO', 'VEGETATIVE'),
      event(2, 'AUTO', 'FLOWERING'),
    ]);
    expect(replay.effectiveStage).toBe('FLOWERING');
    expect(replay.source).toBe('AUTO');
  });

  it('locks to MANUAL and ignores later AUTO events', () => {
    const manual = event(2, 'MANUAL', 'BUD');
    const replay = replayStageEvents([
      event(1, 'AUTO', 'VEGETATIVE'),
      manual,
      event(3, 'AUTO', 'FLOWERING'),
    ]);
    expect(replay.effectiveStage).toBe('BUD');
    expect(replay.source).toBe('MANUAL');
    expect(replay.locked).toBe(true);
    expect(replay.lockingEvent?.id).toBe(manual.id);
  });

  it('RELEASE unlocks and falls back to the latest AUTO while keeping history', () => {
    const auto = event(1, 'AUTO', 'VEGETATIVE');
    const manual = event(2, 'MANUAL', 'BUD');
    const replay = replayStageEvents([
      auto,
      manual,
      event(3, 'RELEASE', null, { targetEventId: manual.id }),
    ]);
    expect(replay.locked).toBe(false);
    expect(replay.effectiveStage).toBe('VEGETATIVE');
    expect(replay.effectiveEvent?.id).toBe(auto.id);
  });

  it('rollback of the latest AUTO restores the previous AUTO stage', () => {
    const firstAuto = event(1, 'AUTO', 'VEGETATIVE');
    const secondAuto = event(2, 'AUTO', 'FLOWERING');
    const rollback = event(3, 'ROLLBACK', null, { targetEventId: secondAuto.id });
    const replay = replayStageEvents([firstAuto, secondAuto, rollback]);
    expect(replay.effectiveStage).toBe('VEGETATIVE');
    expect(replay.voidedIds.has(secondAuto.id)).toBe(true);
  });

  it('rollback of MANUAL unlocks and restores AUTO without deleting history', () => {
    const auto = event(1, 'AUTO', 'VEGETATIVE');
    const manual = event(2, 'MANUAL', 'BUD');
    const rollback = event(3, 'ROLLBACK', null, { targetEventId: manual.id });
    const replay = replayStageEvents([auto, manual, rollback]);
    expect(replay.locked).toBe(false);
    expect(replay.effectiveStage).toBe('VEGETATIVE');
    expect(replay.voidedIds.has(manual.id)).toBe(true);
  });

  it('rollback of an older MANUAL falls back to the latest still-valid MANUAL', () => {
    const firstManual = event(1, 'MANUAL', 'BUD');
    const secondManual = event(2, 'MANUAL', 'FLOWERING');
    const replay = replayStageEvents([
      firstManual,
      secondManual,
      event(3, 'ROLLBACK', null, { targetEventId: secondManual.id }),
    ]);
    expect(replay.locked).toBe(true);
    expect(replay.effectiveStage).toBe('BUD');
  });

  it('voided events stored directly are also excluded', () => {
    const auto = event(1, 'AUTO', 'VEGETATIVE');
    const replay = replayStageEvents([{ ...auto, voidedAt: new Date() }]);
    expect(replay.effectiveStage).toBeNull();
  });
});
