import { describe, expect, it } from 'vitest';
import {
  decideAutoStageUpdate,
  type StageEventRow,
  type StageInference,
} from './growth-stage-engine.js';

function event(partial: Partial<StageEventRow> & Pick<StageEventRow, 'id' | 'stage' | 'source' | 'validFrom'>): StageEventRow {
  return { createdAt: partial.validFrom, supersededAt: null, ...partial };
}

function inference(partial: Partial<StageInference> & Pick<StageInference, 'stage' | 'confidence' | 'transitionAt'>): StageInference {
  return {
    reason: 'test',
    evidence: {
      ruleVersion: 'x',
      windowStart: '2026-05-01T00:00:00.000Z',
      windowEnd: '2026-09-01T00:00:00.000Z',
      signalCount: 3,
      observationCount: 3,
      actionCount: 0,
      matchedSignals: [],
      scores: { GERMINATION: 0, VEGETATIVE: 0, BUD: 0, FLOWERING: 0, FRUITING: 6, DORMANT: 0 },
      supportDays: { GERMINATION: 0, VEGETATIVE: 0, BUD: 0, FLOWERING: 0, FRUITING: 2, DORMANT: 0 },
    },
    ...partial,
  };
}

describe('decideAutoStageUpdate', () => {
  it('appends the first auto event when no history exists', () => {
    const decision = decideAutoStageUpdate({
      events: [],
      inference: inference({ stage: 'FLOWERING', confidence: 'HIGH', transitionAt: new Date('2026-07-10T00:00:00.000Z') }),
    });
    expect(decision.action).toBe('append');
  });

  it('returns none for null or LOW confidence inference', () => {
    expect(decideAutoStageUpdate({
      events: [],
      inference: inference({ stage: null, confidence: null, transitionAt: null }),
    }).action).toBe('none');
    expect(decideAutoStageUpdate({
      events: [],
      inference: inference({ stage: 'BUD', confidence: 'LOW', transitionAt: new Date('2026-06-01T00:00:00.000Z') }),
    }).action).toBe('none');
  });

  it('refreshes evidence (idempotent) when the live auto event already matches', () => {
    const auto = event({
      id: 'auto-1',
      stage: 'FLOWERING',
      source: 'AUTO_INFERRED',
      validFrom: new Date('2026-07-10T00:00:00.000Z'),
    });
    const decision = decideAutoStageUpdate({
      events: [auto],
      inference: inference({ stage: 'FLOWERING', confidence: 'HIGH', transitionAt: new Date('2026-07-10T00:00:00.000Z') }),
    });
    expect(decision).toMatchObject({ action: 'refresh', eventId: 'auto-1' });
  });

  it('supersedes an old auto event but never a human event on stage change', () => {
    const auto = event({
      id: 'auto-1',
      stage: 'VEGETATIVE',
      source: 'AUTO_INFERRED',
      validFrom: new Date('2026-05-01T00:00:00.000Z'),
    });
    const decision = decideAutoStageUpdate({
      events: [auto],
      inference: inference({ stage: 'FLOWERING', confidence: 'HIGH', transitionAt: new Date('2026-07-10T00:00:00.000Z') }),
    });
    expect(decision).toMatchObject({ action: 'append', supersedeEventId: 'auto-1', basedOnEventId: 'auto-1' });

    // 当前生效的是人工修正：即使阶段不同，决策本身也不会要求 supersede 人工事件
    const manual = event({
      id: 'manual-1',
      stage: 'VEGETATIVE',
      source: 'MANUAL_CORRECTION',
      validFrom: new Date('2026-05-01T00:00:00.000Z'),
    });
    const afterManual = decideAutoStageUpdate({
      events: [manual],
      inference: inference({ stage: 'FLOWERING', confidence: 'HIGH', transitionAt: new Date('2026-07-10T00:00:00.000Z') }),
    });
    expect(afterManual.action).toBe('append');
    if (afterManual.action === 'append') {
      expect(afterManual.supersedeEventId).toBeUndefined();
      expect(afterManual.basedOnEventId).toBe('manual-1');
    }
  });

  it('never overrides the human anchor when the inferred transition is at/before it', () => {
    const anchor = event({
      id: 'manual-1',
      stage: 'FRUITING',
      source: 'MANUAL_CORRECTION',
      validFrom: new Date('2026-08-01T00:00:00.000Z'),
    });
    const decision = decideAutoStageUpdate({
      events: [anchor],
      inference: inference({ stage: 'FLOWERING', confidence: 'HIGH', transitionAt: new Date('2026-07-10T00:00:00.000Z') }),
    });
    expect(decision.action).toBe('none');
  });

  it('does not append when inference merely agrees with the human anchor', () => {
    const anchor = event({
      id: 'rollback-1',
      stage: 'DORMANT',
      source: 'ROLLBACK',
      validFrom: new Date('2026-08-01T00:00:00.000Z'),
    });
    const decision = decideAutoStageUpdate({
      events: [anchor],
      inference: inference({ stage: 'DORMANT', confidence: 'HIGH', transitionAt: new Date('2026-08-15T00:00:00.000Z') }),
    });
    expect(decision.action).toBe('none');
  });

  it('chains new auto progression after the anchor even when old auto events exist', () => {
    const oldAuto = event({
      id: 'auto-1',
      stage: 'VEGETATIVE',
      source: 'AUTO_INFERRED',
      validFrom: new Date('2026-05-01T00:00:00.000Z'),
    });
    const anchor = event({
      id: 'manual-1',
      stage: 'BUD',
      source: 'MANUAL_CORRECTION',
      validFrom: new Date('2026-06-01T00:00:00.000Z'),
    });
    const decision = decideAutoStageUpdate({
      events: [oldAuto, anchor],
      inference: inference({ stage: 'FLOWERING', confidence: 'HIGH', transitionAt: new Date('2026-07-10T00:00:00.000Z') }),
    });
    // oldAuto 已失效（人工修正时被取代），追加的事件锚定人工锚点而非旧自动事件
    oldAuto.supersededAt = new Date('2026-06-01T00:00:00.000Z');
    const decision2 = decideAutoStageUpdate({
      events: [oldAuto, anchor],
      inference: inference({ stage: 'FLOWERING', confidence: 'HIGH', transitionAt: new Date('2026-07-10T00:00:00.000Z') }),
    });
    expect(decision.action).toBe('append');
    expect(decision2).toMatchObject({ action: 'append', basedOnEventId: 'manual-1' });
    if (decision2.action === 'append') expect(decision2.supersedeEventId).toBeUndefined();
  });
});
