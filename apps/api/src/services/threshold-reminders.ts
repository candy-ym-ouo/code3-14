import type { Observation, Reminder } from '@prisma/client';
import { prisma } from '../db.js';
import { notifyReminder } from './notifications.js';

const statusRank: Record<string, number> = {
  HEALTHY: 0,
  WATCH: 1,
  CONCERN: 2,
  CRITICAL: 3,
};

function matches(operator: string, actual: number | string, expected: number | string) {
  if (operator === 'EQ') return String(actual) === String(expected);
  const left = typeof actual === 'number' ? actual : Number.NaN;
  const right = typeof expected === 'number' ? expected : Number.NaN;
  if (Number.isNaN(left) || Number.isNaN(right)) return false;
  if (operator === 'GT') return left > right;
  if (operator === 'GTE') return left >= right;
  if (operator === 'LT') return left < right;
  if (operator === 'LTE') return left <= right;
  return false;
}

function observationValue(observation: Observation, metric: string) {
  if (metric === 'TEMPERATURE') return Number(observation.temperatureC);
  if (metric === 'PLANT_STATUS') return observation.plantStatus;
  return null;
}

type ThresholdConfig = { metric: string; operator: string; value: number | string; consecutive?: number };

function thresholdMatches(
  observation: Observation,
  config: ThresholdConfig,
) {
  let actual = observationValue(observation, config.metric);
  let expected = config.value;
  if (config.metric === 'PLANT_STATUS' && typeof actual === 'string' && typeof expected === 'string') {
    if (['GT', 'GTE', 'LT', 'LTE'].includes(config.operator)) {
      const actualRank = statusRank[actual];
      const expectedRank = statusRank[expected];
      if (actualRank === undefined || expectedRank === undefined) return false;
      actual = actualRank;
      expected = expectedRank;
    }
  }
  return actual !== null && matches(config.operator, actual, expected);
}

function reminderTargetMatches(reminder: Reminder, observation: Observation) {
  if (reminder.targetType === 'WORKSPACE') return true;
  if (reminder.targetType === 'BALCONY') return reminder.balconyId === observation.balconyId;
  if (reminder.targetType === 'ZONE') return reminder.zoneId === observation.zoneId;
  if (reminder.targetType === 'PLANT') return Boolean(observation.plantId && reminder.plantId === observation.plantId);
  return false;
}

function reminderTargetWhere(reminder: Reminder, observation: Observation) {
  if (reminder.targetType === 'BALCONY') return { balconyId: observation.balconyId };
  if (reminder.targetType === 'ZONE') return { zoneId: observation.zoneId };
  if (reminder.targetType === 'PLANT') return { plantId: reminder.plantId ?? '' };
  return {};
}

export async function evaluateThresholdReminders(observationId: string) {
  const observation = await prisma.observation.findFirst({
    where: { id: observationId, deletedAt: null },
  });
  if (!observation) return { evaluated: 0, triggered: 0 };

  const reminders = await prisma.reminder.findMany({
    where: { workspaceId: observation.workspaceId, isActive: true, triggerMode: 'THRESHOLD' },
    include: { user: { select: { id: true, email: true, displayName: true } } },
  });

  let triggered = 0;
  for (const reminder of reminders) {
    if (!reminderTargetMatches(reminder, observation)) continue;
    const targetWhere = reminderTargetWhere(reminder, observation);
    const latestForTarget = await prisma.observation.findFirst({
      where: { workspaceId: observation.workspaceId, deletedAt: null, ...targetWhere },
      orderBy: [{ observedAt: 'desc' }, { createdAt: 'desc' }],
      select: { id: true },
    });
    if (latestForTarget?.id !== observation.id) continue;
    const config = reminder.thresholdJson as Partial<ThresholdConfig> | null;
    if (!config?.metric || !config.operator || config.value === undefined) continue;

    const consecutive = Math.max(1, config.consecutive ?? 1);
    const recent = await prisma.observation.findMany({
      where: {
        workspaceId: observation.workspaceId,
        deletedAt: null,
        ...targetWhere,
      },
      orderBy: [{ observedAt: 'desc' }, { createdAt: 'desc' }],
      take: consecutive,
    });
    if (recent.length < consecutive || !recent.every((item) => thresholdMatches(item, config as ThresholdConfig))) {
      continue;
    }

    const latest = await prisma.reminderOccurrence.findFirst({
      where: { reminderId: reminder.id },
      orderBy: { dueAt: 'desc' },
    });
    if (
      latest &&
      latest.sentAt &&
      Date.now() - latest.sentAt.getTime() < reminder.cooldownSeconds * 1000
    ) {
      continue;
    }

    const dueAt = new Date(Math.floor(Date.now() / 60_000) * 60_000);
    const occurrence = await notifyReminder(reminder, dueAt, { advanceSchedule: false });
    if (occurrence) triggered += 1;
  }

  return { evaluated: reminders.length, triggered };
}
