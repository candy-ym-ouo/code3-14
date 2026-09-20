import { describe, expect, it } from 'vitest';
import {
  GROWTH_STAGE_ENGINE_VERSION,
  growthInputFingerprint,
  inferGrowthStage,
  type GrowthStageEngineInput,
} from './growth-stage-engine.js';

const NOW = new Date('2026-09-20T00:00:00.000Z');

function observation(daysAgo: number, plantTags: string[], plantStatus: 'HEALTHY' | 'WATCH' | 'CONCERN' | 'CRITICAL' = 'HEALTHY', id?: string) {
  return {
    id,
    observedAt: new Date(NOW.getTime() - daysAgo * 86_400_000),
    plantTags,
    plantStatus,
  };
}

describe('inferGrowthStage', () => {
  it('returns UNKNOWN when there is no evidence', () => {
    const result = inferGrowthStage({ observations: [], actions: [], acquiredAt: null }, NOW);
    expect(result.stage).toBe('UNKNOWN');
    expect(result.confidence).toBe(0);
    expect(result.engineVersion).toBe(GROWTH_STAGE_ENGINE_VERSION);
  });

  it('infers FLOWERING from recent flowering tags', () => {
    const input: GrowthStageEngineInput = {
      observations: [observation(1, ['开花'], 'HEALTHY', 'o1'), observation(3, ['盛花'], 'HEALTHY', 'o2')],
      actions: [],
      acquiredAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    const result = inferGrowthStage(input, NOW);
    expect(result.stage).toBe('FLOWERING');
    expect(result.signals.filter((signal) => signal.source === 'TAG')).toHaveLength(2);
    expect(result.scores.FLOWERING).toBeGreaterThan(result.scores.VEGETATIVE);
  });

  it('matches english and chinese keywords case-insensitively', () => {
    const result = inferGrowthStage({
      observations: [observation(2, ['BUD forming', '孕蕾'])],
      actions: [],
      acquiredAt: null,
    }, NOW);
    expect(result.stage).toBe('BUD');
  });

  it('down-weights old tags so stale evidence does not dominate', () => {
    const fresh = inferGrowthStage({ observations: [observation(1, ['开花'])], actions: [], acquiredAt: null }, NOW);
    const stale = inferGrowthStage({ observations: [observation(400, ['开花'])], actions: [], acquiredAt: null }, NOW);
    expect(stale.stage).toBe('UNKNOWN');
    expect(fresh.stage).toBe('FLOWERING');
  });

  it('treats health status only as weak senescence evidence', () => {
    const result = inferGrowthStage({
      observations: [observation(1, [], 'CRITICAL')],
      actions: [],
      acquiredAt: null,
    }, NOW);
    expect(result.stage).toBe('UNKNOWN');
    expect(result.scores.SENESCENCE).toBeGreaterThan(0);
  });

  it('uses pruning and fertilizing actions as supporting signals', () => {
    const result = inferGrowthStage({
      observations: [observation(2, ['新叶', '长叶'])],
      actions: [{ id: 'a1', startedAt: new Date(NOW.getTime() - 5 * 86_400_000), actionType: 'FERTILIZE' }],
      acquiredAt: null,
    }, NOW);
    expect(result.stage).toBe('VEGETATIVE');
    expect(result.signals.some((signal) => signal.source === 'ACTION' && signal.matched === 'FERTILIZE')).toBe(true);
  });

  it('applies a weak seedling prior within 30 days of acquisition', () => {
    const result = inferGrowthStage({
      observations: [],
      actions: [],
      acquiredAt: new Date(NOW.getTime() - 10 * 86_400_000),
    }, NOW);
    expect(result.stage).toBe('UNKNOWN');
    expect(result.scores.SEEDLING).toBeGreaterThan(0);
  });

  it('is deterministic for the same input', () => {
    const input: GrowthStageEngineInput = {
      observations: [observation(1, ['开花', 'bud'])],
      actions: [],
      acquiredAt: null,
    };
    expect(inferGrowthStage(input, NOW)).toEqual(inferGrowthStage(input, NOW));
  });
});

describe('growthInputFingerprint', () => {
  it('is stable for the same engine version, data and UTC day', () => {
    const input: GrowthStageEngineInput = {
      observations: [observation(1, ['开花'])],
      actions: [],
      acquiredAt: null,
    };
    const sameDay = new Date('2026-09-20T23:00:00.000Z');
    expect(growthInputFingerprint(input, NOW)).toBe(growthInputFingerprint(input, sameDay));
  });

  it('changes when tag data changes', () => {
    const before: GrowthStageEngineInput = { observations: [observation(1, ['开花'])], actions: [], acquiredAt: null };
    const after: GrowthStageEngineInput = { observations: [observation(1, ['结果'])], actions: [], acquiredAt: null };
    expect(growthInputFingerprint(before, NOW)).not.toBe(growthInputFingerprint(after, NOW));
  });

  it('does not depend on observation array ordering', () => {
    const first: GrowthStageEngineInput = {
      observations: [observation(1, ['开花'], 'HEALTHY', 'o1'), observation(5, ['新叶'], 'HEALTHY', 'o2')],
      actions: [],
      acquiredAt: null,
    };
    const second: GrowthStageEngineInput = {
      observations: [...first.observations].reverse(),
      actions: [],
      acquiredAt: null,
    };
    expect(growthInputFingerprint(first, NOW)).toBe(growthInputFingerprint(second, NOW));
  });
});
