import { describe, expect, it } from 'vitest';
import { STAGE_RULE_VERSION, canonicalTag, inferStage, type StageSignal } from './growth-stage-engine.js';

const windowStart = new Date('2026-05-01T00:00:00.000Z');
const windowEnd = new Date('2026-09-01T00:00:00.000Z');

function obs(at: string, tags: string[] = [], actionType?: StageSignal['actionType']): StageSignal {
  return { at: new Date(at), tags, actionType };
}

describe('canonicalTag', () => {
  it('maps Chinese and English tags to a stage', () => {
    expect(canonicalTag('开花')?.stage).toBe('FLOWERING');
    expect(canonicalTag('Buds forming')?.stage).toBe('BUD');
    expect(canonicalTag('开始结果了')?.stage).toBe('FRUITING');
    expect(canonicalTag('植株进入休眠')?.stage).toBe('DORMANT');
    expect(canonicalTag('修剪')?.stage).toBeUndefined();
    expect(canonicalTag('   ')).toBeNull();
  });

  it('prefers ripe fruit over generic fruit keywords', () => {
    expect(canonicalTag('果实成熟可以采收')?.rule).toBe('tag:ripe-fruit');
    expect(canonicalTag('花谢后')?.stage).toBe('FRUITING');
  });
});

describe('inferStage', () => {
  it('returns null when there is no stage-related evidence', () => {
    const result = inferStage({
      signals: [obs('2026-05-02T08:00:00.000Z', ['浇水记录']), obs('2026-05-03T08:00:00.000Z')],
      windowStart,
      windowEnd,
    });
    expect(result.stage).toBeNull();
    expect(result.transitionAt).toBeNull();
    expect(result.evidence.signalCount).toBe(2);
  });

  it('infers flowering from repeated flowering tags across days', () => {
    const result = inferStage({
      signals: [
        obs('2026-06-01T08:00:00.000Z', ['新叶']),
        obs('2026-07-10T08:00:00.000Z', ['开花']),
        obs('2026-07-11T08:00:00.000Z', ['盛花，开花']),
        obs('2026-07-12T08:00:00.000Z', ['bloom']),
      ],
      windowStart,
      windowEnd,
    });
    expect(result.stage).toBe('FLOWERING');
    expect(result.confidence).toBe('HIGH');
    expect(result.transitionAt?.toISOString()).toBe('2026-07-10T08:00:00.000Z');
    expect(result.evidence.scores.FLOWERING).toBeGreaterThanOrEqual(6);
    expect(result.evidence.supportDays.FLOWERING).toBe(3);
    expect(result.evidence.ruleVersion).toBe(STAGE_RULE_VERSION);
  });

  it('dedupes the same canonical tag within a single observation', () => {
    const result = inferStage({
      signals: [obs('2026-07-10T08:00:00.000Z', ['开花', '盛花', '花开了'])],
      windowStart,
      windowEnd,
    });
    expect(result.evidence.scores.FLOWERING).toBe(3);
  });

  it('treats prune as weak vegetative evidence', () => {
    const result = inferStage({
      signals: [
        obs('2026-05-02T08:00:00.000Z', ['新叶', '长叶']),
        obs('2026-05-03T08:00:00.000Z', ['新枝']),
        obs('2026-05-04T08:00:00.000Z', [], 'PRUNE'),
      ],
      windowStart,
      windowEnd,
    });
    expect(result.stage).toBe('VEGETATIVE');
  });

  it('ignores signals outside the evidence window (deterministic recompute)', () => {
    const result = inferStage({
      signals: [
        obs('2026-04-30T23:59:00.000Z', ['开花']),
        obs('2026-09-02T00:00:00.000Z', ['开花']),
      ],
      windowStart,
      windowEnd,
    });
    expect(result.stage).toBeNull();
  });

  it('does not let a single dormant tag beat repeated flowering evidence', () => {
    const result = inferStage({
      signals: [
        obs('2026-07-10T08:00:00.000Z', ['开花']),
        obs('2026-07-11T08:00:00.000Z', ['盛花']),
        obs('2026-07-12T08:00:00.000Z', ['落叶休眠']),
      ],
      windowStart,
      windowEnd,
    });
    // FLOWERING 6 分 > DORMANT 3 分
    expect(result.stage).toBe('FLOWERING');
  });

  it('is deterministic: the same inputs produce the same evidence', () => {
    const signals = [
      obs('2026-05-02T08:00:00.000Z', ['发芽']),
      obs('2026-07-10T08:00:00.000Z', ['开花']),
      obs('2026-07-11T08:00:00.000Z', ['开花']),
    ];
    const first = inferStage({ signals, windowStart, windowEnd });
    const second = inferStage({ signals: [...signals].reverse(), windowStart, windowEnd });
    expect(second).toEqual(first);
  });
});
