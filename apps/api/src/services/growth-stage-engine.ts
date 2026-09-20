import { createHash } from 'node:crypto';
import type { GrowthStage } from '@balcony/shared';

/**
 * 植物生长阶段推断引擎（纯函数层）。
 *
 * 约定：
 * - 本模块只产出“证据/建议”，不决定最终生效阶段；最终判断由事件账本（人工修正优先）决定。
 * - 输出对同一输入完全可复算；引擎版本变化会令旧指纹失效，从而触发重算。
 */

export const GROWTH_STAGE_ENGINE_VERSION = 'growth-stage-engine-v1';

/** 评分半衰期：越旧的标签/操作信号权重越低（30 天减半） */
const SCORE_HALF_LIFE_DAYS = 30;
/** 超过该天数的信号不再计分，避免远古数据长期主导 */
const MAX_SIGNAL_AGE_DAYS = 365;
/** 获胜阶段至少需要的累计（衰减后）权重，否则判 UNKNOWN */
const MIN_WINNING_SCORE = 0.6;
/** 获胜阶段至少需要的得分占比，避免多个阶段证据势均力敌时武断下结论 */
const MIN_CONFIDENCE = 0.35;

const INFERABLE_STAGES: GrowthStage[] = [
  'SEEDLING',
  'VEGETATIVE',
  'BUD',
  'FLOWERING',
  'FRUITING',
  'SENESCENCE',
  'DORMANT',
];

const TAG_KEYWORDS: ReadonlyArray<readonly [GrowthStage, readonly string[]]> = [
  ['SEEDLING', ['发芽', '出苗', '子叶', '幼苗', '种苗', 'seedling', 'sprout', 'cotyledon', 'germinat']],
  ['VEGETATIVE', ['长叶', '新叶', '展叶', '抽枝', '徒长', '生长旺盛', 'vegetative', 'foliage', 'leaf', 'leaves']],
  ['BUD', ['孕蕾', '现蕾', '花苞', '花蕾', '芽点', 'bud']],
  ['FLOWERING', ['开花', '盛放', '花瓣', '初花', '盛花', '落花', 'flower', 'bloom', 'blossom']],
  ['FRUITING', ['结果', '坐果', '挂果', '果实', '膨果', '结果实', 'fruit', 'ripen']],
  ['SENESCENCE', ['枯萎', '枯黄', '黄叶', '落叶', '凋谢', '干枯', 'wilt', 'yellow', 'senesc']],
  ['DORMANT', ['休眠', '越冬', 'dormant']],
];

const ACTION_WEIGHTS: Readonly<Record<string, ReadonlyArray<readonly [GrowthStage, number]>>> = {
  PRUNE: [['SENESCENCE', 0.3]],
  FERTILIZE: [['VEGETATIVE', 0.3]],
  REPOT: [['VEGETATIVE', 0.25]],
  WATER: [['VEGETATIVE', 0.1]],
};

export interface ObservationSignalInput {
  id?: string;
  observedAt: Date;
  plantTags: readonly string[];
  plantStatus: 'HEALTHY' | 'WATCH' | 'CONCERN' | 'CRITICAL';
}

export interface ActionSignalInput {
  id?: string;
  startedAt: Date;
  actionType: 'SHADE' | 'WATER' | 'REPOT' | 'MOVE' | 'FERTILIZE' | 'PRUNE' | 'CUSTOM';
}

export interface GrowthStageEngineInput {
  observations: readonly ObservationSignalInput[];
  actions: readonly ActionSignalInput[];
  acquiredAt: Date | null;
}

export interface InferenceSignal {
  stage: GrowthStage;
  source: 'TAG' | 'ACTION' | 'STATUS' | 'PRIOR';
  sourceId: string | null;
  matched: string;
  rawWeight: number;
  weight: number;
  ageDays: number;
  occurredAt: string;
}

export interface GrowthStageInference {
  stage: GrowthStage;
  confidence: number;
  scores: Record<GrowthStage, number>;
  signals: InferenceSignal[];
  observationCount: number;
  actionCount: number;
  dataFrom: string | null;
  dataTo: string | null;
  engineVersion: string;
}

function emptyScores(): Record<GrowthStage, number> {
  return {
    UNKNOWN: 0,
    SEEDLING: 0,
    VEGETATIVE: 0,
    BUD: 0,
    FLOWERING: 0,
    FRUITING: 0,
    SENESCENCE: 0,
    DORMANT: 0,
  };
}

function round4(value: number) {
  return Math.round(value * 10_000) / 10_000;
}

function decayWeight(rawWeight: number, ageDays: number) {
  if (ageDays < 0) return 0;
  if (ageDays > MAX_SIGNAL_AGE_DAYS) return 0;
  return rawWeight * 2 ** (-ageDays / SCORE_HALF_LIFE_DAYS);
}

function matchStage(tag: string): { stage: GrowthStage; keyword: string } | null {
  const normalized = tag.trim().toLowerCase();
  if (!normalized) return null;
  for (const [stage, keywords] of TAG_KEYWORDS) {
    for (const keyword of keywords) {
      if (normalized.includes(keyword)) return { stage, keyword };
    }
  }
  return null;
}

/**
 * 由时间序列推断生长阶段。同输入 + 同一自然日 => 同输出（衰减按天计）。
 */
export function inferGrowthStage(input: GrowthStageEngineInput, now: Date = new Date()): GrowthStageInference {
  const scores = emptyScores();
  const signals: InferenceSignal[] = [];

  const observations = [...input.observations].sort(
    (a, b) => a.observedAt.getTime() - b.observedAt.getTime() || (a.id ?? '').localeCompare(b.id ?? ''),
  );
  const actions = [...input.actions].sort(
    (a, b) => a.startedAt.getTime() - b.startedAt.getTime() || (a.id ?? '').localeCompare(b.id ?? ''),
  );

  for (const observation of observations) {
    const ageDays = Math.max(0, (now.getTime() - observation.observedAt.getTime()) / 86_400_000);
    for (const tag of observation.plantTags) {
      const match = matchStage(tag);
      if (!match) continue;
      const weight = decayWeight(1, ageDays);
      if (weight <= 0) continue;
      scores[match.stage] += weight;
      signals.push({
        stage: match.stage,
        source: 'TAG',
        sourceId: observation.id ?? null,
        matched: match.keyword,
        rawWeight: 1,
        weight: round4(weight),
        ageDays: Math.round(ageDays * 10) / 10,
        occurredAt: observation.observedAt.toISOString(),
      });
    }
    // 健康状态描述的是“长势”而非阶段，仅对衰老给出很弱的旁证
    if (observation.plantStatus === 'CONCERN' || observation.plantStatus === 'CRITICAL') {
      const weight = decayWeight(observation.plantStatus === 'CRITICAL' ? 0.2 : 0.1, ageDays);
      if (weight > 0) {
        scores.SENESCENCE += weight;
        signals.push({
          stage: 'SENESCENCE',
          source: 'STATUS',
          sourceId: observation.id ?? null,
          matched: observation.plantStatus,
          rawWeight: observation.plantStatus === 'CRITICAL' ? 0.2 : 0.1,
          weight: round4(weight),
          ageDays: Math.round(ageDays * 10) / 10,
          occurredAt: observation.observedAt.toISOString(),
        });
      }
    }
  }

  for (const action of actions) {
    const mapped = ACTION_WEIGHTS[action.actionType];
    if (!mapped) continue;
    const ageDays = Math.max(0, (now.getTime() - action.startedAt.getTime()) / 86_400_000);
    for (const [stage, rawWeight] of mapped) {
      const weight = decayWeight(rawWeight, ageDays);
      if (weight <= 0) continue;
      scores[stage] += weight;
      signals.push({
        stage,
        source: 'ACTION',
        sourceId: action.id ?? null,
        matched: action.actionType,
        rawWeight,
        weight: round4(weight),
        ageDays: Math.round(ageDays * 10) / 10,
        occurredAt: action.startedAt.toISOString(),
      });
    }
  }

  // 购入 30 天内的植物更可能处于幼苗期（弱先验，随购入时长衰减）
  if (input.acquiredAt) {
    const ageDays = (now.getTime() - input.acquiredAt.getTime()) / 86_400_000;
    if (ageDays >= 0 && ageDays <= 30) {
      const weight = decayWeight(0.4, ageDays);
      scores.SEEDLING += weight;
      signals.push({
        stage: 'SEEDLING',
        source: 'PRIOR',
        sourceId: null,
        matched: 'ACQUIRED_AGE',
        rawWeight: 0.4,
        weight: round4(weight),
        ageDays: Math.round(ageDays * 10) / 10,
        occurredAt: input.acquiredAt.toISOString(),
      });
    }
  }

  let winner: GrowthStage = 'UNKNOWN';
  let winningScore = 0;
  let totalScore = 0;
  for (const stage of INFERABLE_STAGES) {
    const score = round4(scores[stage]);
    scores[stage] = score;
    totalScore += score;
    // INFERABLE_STAGES 顺序固定，平分时取生命周期更早的阶段，保证确定性
    if (score > winningScore) {
      winningScore = score;
      winner = stage;
    }
  }

  const confidence = totalScore > 0 ? winningScore / totalScore : 0;
  const stage = winningScore >= MIN_WINNING_SCORE && confidence >= MIN_CONFIDENCE ? winner : 'UNKNOWN';

  const timestamps = [...observations.map((item) => item.observedAt), ...actions.map((item) => item.startedAt)];
  timestamps.sort((a, b) => a.getTime() - b.getTime());

  return {
    stage,
    confidence: stage === 'UNKNOWN' ? 0 : round4(confidence),
    scores,
    signals: signals.sort((a, b) => b.weight - a.weight).slice(0, 100),
    observationCount: observations.length,
    actionCount: actions.length,
    dataFrom: timestamps[0]?.toISOString() ?? null,
    dataTo: timestamps.at(-1)?.toISOString() ?? null,
    engineVersion: GROWTH_STAGE_ENGINE_VERSION,
  };
}

/**
 * 推断输入的指纹：同引擎版本、同数据、同一 UTC 自然日下保持稳定。
 * 衰减权重随时间连续变化，因此指纹包含 UTC 日期：跨天即视为证据更新，可触发重新推断；
 * 同一天内重复调用则保持幂等。证据行本身允许随时覆盖。
 */
export function growthInputFingerprint(input: GrowthStageEngineInput, now: Date = new Date()): string {
  const canonical = {
    v: GROWTH_STAGE_ENGINE_VERSION,
    day: now.toISOString().slice(0, 10),
    acquiredAt: input.acquiredAt?.getTime() ?? null,
    observations: input.observations
      .map((item) => [item.observedAt.getTime(), [...item.plantTags].sort(), item.plantStatus, item.id ?? null])
      .sort((a, b) => Number(a[0]) - Number(b[0])),
    actions: input.actions
      .map((item) => [item.startedAt.getTime(), item.actionType, item.id ?? null])
      .sort((a, b) => Number(a[0]) - Number(b[0])),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
