/**
 * 植物生长阶段推断规则引擎（纯函数、确定性、可重算）。
 *
 * 设计原则：
 * - 无副作用：相同输入永远得到相同输出，证据快照可随时用同一 ruleVersion 重算。
 * - 只产出「推断建议」；是否写入、是否覆盖既有事件由 service 层依据人工锚点决定，
 *   人工判断永不被自动推断覆盖（见 growth-stage.ts）。
 */

export const STAGE_RULE_VERSION = 'growth-stage-rules-1.0.0';

export type GrowthStage = 'GERMINATION' | 'VEGETATIVE' | 'BUD' | 'FLOWERING' | 'FRUITING' | 'DORMANT';

export type StageConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

/** 有序生长阶段（自然推进顺序）；DORMANT 为特殊休眠态，可在任意阶段进出 */
export const STAGE_ORDER: GrowthStage[] = ['GERMINATION', 'VEGETATIVE', 'BUD', 'FLOWERING', 'FRUITING', 'DORMANT'];

/** 推断引擎的单一时间点信号：观察记录、操作记录都归一化为此结构 */
export interface StageSignal {
  at: Date;
  /** 观察标签（自由文本，经 canonicalTag 归一化），如「开花」「结果」「发芽」 */
  tags?: string[];
  /** 观察记录的健康状态 */
  plantStatus?: 'HEALTHY' | 'WATCH' | 'CONCERN' | 'CRITICAL';
  /** 干预类型，PRUNE 等会影响阶段判断 */
  actionType?: 'SHADE' | 'WATER' | 'REPOT' | 'MOVE' | 'FERTILIZE' | 'PRUNE' | 'CUSTOM';
}

export interface StageEvidence {
  ruleVersion: string;
  windowStart: string;
  windowEnd: string;
  signalCount: number;
  observationCount: number;
  actionCount: number;
  /** 命中规则的信号（最多保留 50 条，按时间升序） */
  matchedSignals: Array<{
    at: string;
    stage: GrowthStage;
    weight: number;
    rule: string;
    tag?: string;
    actionType?: StageSignal['actionType'];
  }>;
  /** 各阶段得分（整数权重和） */
  scores: Record<GrowthStage, number>;
  /** 支持各阶段的不同观测日期数量（YYYY-MM-DD，UTC） */
  supportDays: Record<GrowthStage, number>;
}

export interface StageInference {
  stage: GrowthStage | null;
  confidence: StageConfidence | null;
  transitionAt: Date | null;
  reason: string;
  evidence: StageEvidence;
}

/** 事件行的最小结构（与 Prisma 的 PlantStageEvent 结构兼容） */
export interface StageEventRow {
  id: string;
  stage: GrowthStage;
  source: 'AUTO_INFERRED' | 'MANUAL_CORRECTION' | 'ROLLBACK';
  validFrom: Date;
  createdAt: Date;
  supersededAt: Date | null;
}

export type StageMergeDecision =
  | { action: 'none'; reason: string }
  | { action: 'refresh'; eventId: string; reason: string }
  | {
      action: 'append';
      reason: string;
      stage: GrowthStage;
      validFrom: Date;
      /** 新自动事件取代的旧自动事件（人工事件绝不会出现在这里） */
      supersedeEventId?: string;
      /** 原因链锚点：最近人工事件，或被取代的旧自动事件 */
      basedOnEventId?: string;
    };

/** 人工事件即锚点：自动推断不能越过它重写过去 */
export function isHumanStageSource(source: StageEventRow['source']): boolean {
  return source === 'MANUAL_CORRECTION' || source === 'ROLLBACK';
}

function liveStageEvents(events: StageEventRow[]): StageEventRow[] {
  return events.filter((event) => event.supersededAt === null);
}

/** 最近一条有效事件（validFrom 最新） */
export function latestLiveStageEvent(events: StageEventRow[]): StageEventRow | null {
  const live = liveStageEvents(events);
  if (live.length === 0) return null;
  return [...live].sort((a, b) => {
    const byValidFrom = b.validFrom.getTime() - a.validFrom.getTime();
    if (byValidFrom !== 0) return byValidFrom;
    return b.createdAt.getTime() - a.createdAt.getTime();
  })[0]!;
}

/** 最近一条有效人工锚点 */
export function latestHumanAnchor(events: StageEventRow[]): StageEventRow | null {
  const anchors = liveStageEvents(events)
    .filter((event) => isHumanStageSource(event.source))
    .sort((a, b) => b.validFrom.getTime() - a.validFrom.getTime());
  return anchors[0] ?? null;
}

/**
 * 纯决策：给定已有事件与最新推断结果，决定自动推断应如何落库。
 * 该函数集中表达「证据可重算但不可覆盖人工判断」的全部规则，便于单测重放。
 */
export function decideAutoStageUpdate(input: {
  events: StageEventRow[];
  inference: StageInference;
}): StageMergeDecision {
  const { inference } = input;
  const current = latestLiveStageEvent(input.events);
  const anchor = latestHumanAnchor(input.events);

  if (!inference.stage || !inference.transitionAt || inference.confidence === 'LOW') {
    return { action: 'none', reason: '证据不足或低置信度，保持现有阶段判定' };
  }

  // 有锚点时：推断转换点不得落在锚点之前（自动推断不得改写人工判定覆盖的时段）
  if (anchor && inference.transitionAt.getTime() <= anchor.validFrom.getTime()) {
    return { action: 'none', reason: '推断转换点不晚于最近人工锚点，人工判断优先' };
  }

  const currentAuto = current && current.source === 'AUTO_INFERRED' ? current : null;

  // 与当前有效自动事件一致 → 只刷新证据，不新增事件（重算幂等）
  if (currentAuto && currentAuto.stage === inference.stage) {
    return { action: 'refresh', eventId: currentAuto.id, reason: '推断结论一致，刷新证据快照' };
  }

  // 当前是人工事件且阶段相同 → 无需追加
  if (current && isHumanStageSource(current.source) && current.stage === inference.stage) {
    return { action: 'none', reason: '推断与人工锚点阶段一致，保持人工判断' };
  }

  return {
    action: 'append',
    reason: inference.reason,
    stage: inference.stage,
    validFrom: inference.transitionAt,
    ...(currentAuto ? { supersedeEventId: currentAuto.id } : {}),
    ...(anchor ? { basedOnEventId: anchor.id } : currentAuto ? { basedOnEventId: currentAuto.id } : {}),
  };
}

type CanonicalTag = 'SPROUT' | 'NEW_LEAF' | 'BUD' | 'FLOWERING' | 'WILTED_FLOWER' | 'FRUIT' | 'RIPE_FRUIT' | 'DORMANT';

interface TagRule {
  canonical: CanonicalTag;
  stage: GrowthStage;
  weight: number;
  rule: string;
  /** 长词优先匹配，避免「疏果」之类误命中纯子串 */
  keywords: string[];
}

const TAG_RULES: TagRule[] = [
  { canonical: 'RIPE_FRUIT', stage: 'FRUITING', weight: 3, rule: 'tag:ripe-fruit', keywords: ['成熟', '果熟', '熟透', '采收', '收获', '摘果', 'ripe', 'harvest'] },
  { canonical: 'FRUIT', stage: 'FRUITING', weight: 3, rule: 'tag:fruit', keywords: ['结果', '坐果', '挂果', '幼果', '果实', '浆果', '结籽', '果荚', '果子', '果', 'fruit', 'fruiting'] },
  { canonical: 'WILTED_FLOWER', stage: 'FRUITING', weight: 2, rule: 'tag:wilted-flower', keywords: ['花谢', '谢花', '落花', '残花', '枯萎的花', '花后', 'wilted flower', 'petal fall', 'flower drop'] },
  { canonical: 'FLOWERING', stage: 'FLOWERING', weight: 3, rule: 'tag:flowering', keywords: ['开花', '盛花', '绽放', '花蕾开放', '花开', '花苞开', '花序', '开花了', 'flowering', 'bloom', 'blossom', 'in flower'] },
  { canonical: 'BUD', stage: 'BUD', weight: 2, rule: 'tag:bud', keywords: ['孕蕾', '现蕾', '抽蕾', '花苞', '花蕾', '花芽', '打苞', '结苞', '蕾', 'bud', 'budding'] },
  { canonical: 'DORMANT', stage: 'DORMANT', weight: 3, rule: 'tag:dormant', keywords: ['休眠', '越冬', '冬眠', '停止生长', '落叶休眠', 'dormant', 'dormancy'] },
  { canonical: 'SPROUT', stage: 'GERMINATION', weight: 3, rule: 'tag:sprout', keywords: ['发芽', '萌芽', '出苗', '露白', '破土', '萌发', '抽芽', '新芽', 'germinate', 'germination', 'sprout', 'sprouting', 'emergence'] },
  { canonical: 'NEW_LEAF', stage: 'VEGETATIVE', weight: 1, rule: 'tag:new-leaf', keywords: ['新叶', '长叶', '展叶', '抽枝', '新枝', '生长旺盛', '长势', '徒长', '长个', 'new leaf', 'leafing', 'vegetative'] },
];

/** 归一化单个标签为规范信号；命中长关键词优先 */
export function canonicalTag(rawTag: string): { tag: CanonicalTag; stage: GrowthStage; weight: number; rule: string; matched: string } | null {
  const tag = rawTag.trim().toLowerCase();
  if (!tag) return null;
  for (const rule of TAG_RULES) {
    const matched = rule.keywords.find((keyword) => tag.includes(keyword.toLowerCase()));
    if (matched) {
      return { tag: rule.canonical, stage: rule.stage, weight: rule.weight, rule: rule.rule, matched };
    }
  }
  return null;
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function emptyScores(): Record<GrowthStage, number> {
  return { GERMINATION: 0, VEGETATIVE: 0, BUD: 0, FLOWERING: 0, FRUITING: 0, DORMANT: 0 };
}

function rankStage(stage: GrowthStage): number {
  return STAGE_ORDER.indexOf(stage);
}

/**
 * 基于时间序列信号推断「窗口内最新的明确阶段」。
 *
 * @param signals 时间序列信号（观察 + 干预），无需预先排序
 * @param window 推断窗口；窗口外信号一律忽略，保证重算输入一致
 */
export function inferStage(input: {
  signals: StageSignal[];
  windowStart: Date;
  windowEnd: Date;
  /** 植物到手时间：用于把「早期、无强信号」识别为发芽期 */
  acquiredAt?: Date | null;
}): StageInference {
  const { windowStart, windowEnd } = input;
  const scores = emptyScores();
  const supportDays = new Map<GrowthStage, Set<string>>();
  const matchedSignals: StageEvidence['matchedSignals'] = [];
  let observationCount = 0;
  let actionCount = 0;

  const signals = [...input.signals]
    .filter((signal) => {
      const time = signal.at.getTime();
      return time >= windowStart.getTime() && time < windowEnd.getTime();
    })
    .sort((a, b) => a.at.getTime() - b.at.getTime());

  const addSupport = (stage: GrowthStage, at: Date, weight: number) => {
    scores[stage] += weight;
    const days = supportDays.get(stage) ?? new Set<string>();
    days.add(dayKey(at));
    supportDays.set(stage, days);
  };

  for (const signal of signals) {
    if (signal.tags) observationCount += 1;
    if (signal.actionType) actionCount += 1;

    // 一个信号可能携带多个标签；同一规范标签在单条信号内只计一次
    const seenCanonical = new Set<CanonicalTag>();
    for (const rawTag of signal.tags ?? []) {
      const hit = canonicalTag(rawTag);
      if (!hit || seenCanonical.has(hit.tag)) continue;
      seenCanonical.add(hit.tag);
      addSupport(hit.stage, signal.at, hit.weight);
      if (matchedSignals.length < 200) {
        matchedSignals.push({ at: signal.at.toISOString(), stage: hit.stage, weight: hit.weight, rule: hit.rule, tag: rawTag });
      }
    }

    // 修剪通常意味着营养生长管理（休眠期强修剪除外，休眠由标签强信号主导）
    if (signal.actionType === 'PRUNE') {
      addSupport('VEGETATIVE', signal.at, 1);
      if (matchedSignals.length < 200) {
        matchedSignals.push({ at: signal.at.toISOString(), stage: 'VEGETATIVE', weight: 1, rule: 'action:prune', actionType: 'PRUNE' });
      }
    }
  }

  const supportDaysRecord = emptyScores();
  for (const stage of STAGE_ORDER) {
    supportDaysRecord[stage] = supportDays.get(stage)?.size ?? 0;
  }

  const evidence: StageEvidence = {
    ruleVersion: STAGE_RULE_VERSION,
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    signalCount: signals.length,
    observationCount,
    actionCount,
    matchedSignals: matchedSignals.slice(0, 50),
    scores,
    supportDays: supportDaysRecord,
  };

  const candidates = STAGE_ORDER.filter((stage) => scores[stage] > 0);
  if (candidates.length === 0) {
    return {
      stage: null,
      confidence: null,
      transitionAt: null,
      reason: '窗口内没有任何阶段相关标签或干预信号，保持人工/历史判定',
      evidence,
    };
  }

  // 选择规则：得分优先；得分相同则「支持天数」多者优先；再相同取阶段靠后者（生命进程向前），
  // 但 DORMANT 在平分时不抢占 FLOWERING/FRUITING（防止单次「落叶」误判休眠）。
  const winner = candidates.reduce((best, stage) => {
    if (scores[stage] > scores[best]) return stage;
    if (scores[stage] === scores[best]) {
      if (supportDaysRecord[stage] > supportDaysRecord[best]) return stage;
      if (supportDaysRecord[stage] === supportDaysRecord[best]) {
        if (best === 'DORMANT' && stage !== 'DORMANT') return stage;
        if (rankStage(stage) > rankStage(best)) return stage;
      }
    }
    return best;
  }, candidates[0]!);

  const days = supportDaysRecord[winner];
  const confidence: StageConfidence = scores[winner] >= 5 && days >= 2 ? 'HIGH' : scores[winner] >= 3 ? 'MEDIUM' : 'LOW';

  // 转换时间 = 支持获胜阶段的最早信号时间
  const firstHit = matchedSignals.find((item) => item.stage === winner);
  const transitionAt = firstHit ? new Date(firstHit.at) : null;

  return {
    stage: winner,
    confidence,
    transitionAt,
    reason: `规则 ${STAGE_RULE_VERSION}：阶段 ${winner} 得分 ${scores[winner]}、覆盖 ${days} 个观测日，置信度 ${confidence}`,
    evidence,
  };
}
