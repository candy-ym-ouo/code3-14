import type { LightLevel, Observation, PlantStatus, Prisma, WindDirection } from '@prisma/client';
import dayjs from 'dayjs';
import { prisma } from '../db.js';
import { requireWorkspaceRole } from './authorization.js';
import { AppError } from '../lib/errors.js';

export type Metric = 'temperature' | 'light' | 'wind' | 'plant_status';
export type Bucket = 'raw' | 'hour' | 'day' | 'week';

type Scope =
  | { type: 'workspace'; workspaceId: string }
  | { type: 'balcony'; workspaceId: string; balconyId: string }
  | { type: 'zone'; workspaceId: string; zoneId: string }
  | { type: 'plant'; workspaceId: string; plantId: string };

function number(value: unknown): number {
  return Number(value);
}

function mean(values: number[]) {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number | null, digits = 2) {
  if (value === null) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function downsample<T>(points: T[], maxPoints = 500) {
  if (points.length <= maxPoints) return { points, downsampled: false };
  const step = Math.ceil(points.length / maxPoints);
  return {
    points: points.filter((_, index) => index % step === 0).slice(0, maxPoints),
    downsampled: true,
  };
}

function distribution<T extends string>(values: T[]) {
  return values.reduce<Record<string, number>>((result, value) => {
    result[value] = (result[value] ?? 0) + 1;
    return result;
  }, {});
}

function bucketKey(date: Date, bucket: Bucket, timezoneName: string) {
  if (bucket === 'raw') return date.toISOString();
  if (bucket === 'hour') return dayjs(date).tz(timezoneName).format('YYYY-MM-DDTHH:00');
  if (bucket === 'week') return dayjs(date).tz(timezoneName).startOf('week').format('YYYY-MM-DD');
  return dayjs(date).tz(timezoneName).format('YYYY-MM-DD');
}

function observationWhere(scope: Scope, from: Date, to: Date): Prisma.ObservationWhereInput {
  const base: Prisma.ObservationWhereInput = {
    workspaceId: scope.workspaceId,
    deletedAt: null,
    observedAt: { gte: from, lt: to },
  };
  if (scope.type === 'balcony') return { ...base, balconyId: scope.balconyId };
  if (scope.type === 'zone') return { ...base, zoneId: scope.zoneId };
  if (scope.type === 'plant') return { ...base, plantId: scope.plantId };
  return base;
}

export async function buildSeries(input: {
  userId: string;
  scope: Scope;
  metric: Metric;
  from: Date;
  to: Date;
  bucket: Bucket;
  timezone: string;
}) {
  await requireWorkspaceRole(input.userId, input.scope.workspaceId, 'VIEWER');
  if (input.scope.type === 'balcony') {
    const exists = await prisma.balcony.findFirst({
      where: { id: input.scope.balconyId, workspaceId: input.scope.workspaceId, archivedAt: null },
      select: { id: true },
    });
    if (!exists) throw new AppError(404, 'BALCONY_NOT_FOUND', '阳台不存在');
  }
  if (input.scope.type === 'zone') {
    const exists = await prisma.zone.findFirst({
      where: { id: input.scope.zoneId, archivedAt: null, balcony: { workspaceId: input.scope.workspaceId } },
      select: { id: true },
    });
    if (!exists) throw new AppError(404, 'ZONE_NOT_FOUND', '位置不存在');
  }
  if (input.scope.type === 'plant') {
    const exists = await prisma.plant.findFirst({
      where: { id: input.scope.plantId, workspaceId: input.scope.workspaceId, archivedAt: null },
      select: { id: true },
    });
    if (!exists) throw new AppError(404, 'PLANT_NOT_FOUND', '植物不存在');
  }

  const observations = await prisma.observation.findMany({
    where: observationWhere(input.scope, input.from, input.to),
    orderBy: { observedAt: 'asc' },
    take: 50_000,
  });

  if (input.metric === 'temperature') {
    const grouped = new Map<string, number[]>();
    for (const item of observations) {
      const key = bucketKey(item.observedAt, input.bucket, input.timezone);
      const values = grouped.get(key) ?? [];
      values.push(number(item.temperatureC));
      grouped.set(key, values);
    }
    const limited = downsample([...grouped.entries()].map(([time, values]) => ({
      time,
      min: round(Math.min(...values)),
      max: round(Math.max(...values)),
      avg: round(mean(values)),
      count: values.length,
    })));
    return {
      metric: input.metric,
      bucket: input.bucket,
      timezone: input.timezone,
      points: limited.points,
      meta: { sampleCount: observations.length, capped: observations.length === 50_000, downsampled: limited.downsampled },
    };
  }

  if (input.metric === 'light') {
    const luxPoints = observations
      .filter((item) => item.lux !== null)
      .map((item) => ({
        time: bucketKey(item.observedAt, input.bucket, input.timezone),
        lux: item.lux,
      }));
    return {
      metric: input.metric,
      bucket: input.bucket,
      timezone: input.timezone,
      points: downsample(luxPoints).points,
      distribution: distribution(observations.map((item) => item.lightLevel)),
      meta: { sampleCount: observations.length, luxSampleCount: luxPoints.length, downsampled: downsample(luxPoints).downsampled },
    };
  }

  if (input.metric === 'wind') {
    return {
      metric: input.metric,
      bucket: input.bucket,
      timezone: input.timezone,
      points: downsample(observations.map((item) => ({
        time: item.observedAt.toISOString(),
        direction: item.windDirection,
        degrees: item.windDegrees,
        speedMps: item.windSpeedMps === null ? null : number(item.windSpeedMps),
      }))).points,
      distribution: distribution(observations.map((item) => item.windDirection)),
      meta: { sampleCount: observations.length, downsampled: observations.length > 500 },
    };
  }

  const latestByBucket = new Map<string, Observation>();
  for (const item of observations) {
    latestByBucket.set(bucketKey(item.observedAt, input.bucket, input.timezone), item);
  }
  const plantPoints = downsample([...latestByBucket.entries()].map(([time, item]) => ({
    time,
    status: item.plantStatus,
    tags: item.plantTags,
    observedAt: item.observedAt.toISOString(),
  })));
  return {
    metric: input.metric,
    bucket: input.bucket,
    timezone: input.timezone,
    points: plantPoints.points,
    meta: { sampleCount: observations.length, downsampled: plantPoints.downsampled },
  };
}

export async function buildComparison(input: {
  userId: string;
  actionId: string;
  beforeDays: number;
  afterDays: number;
}) {
  const action = await prisma.actionLog.findFirst({
    where: { id: input.actionId, deletedAt: null },
    include: { workspace: true },
  });
  if (!action) throw new AppError(404, 'ACTION_NOT_FOUND', '操作记录不存在');
  await requireWorkspaceRole(input.userId, action.workspaceId, 'VIEWER');

  const anchor = action.startedAt;
  const beforeFrom = new Date(anchor.getTime() - input.beforeDays * 86_400_000);
  const afterTo = new Date(anchor.getTime() + input.afterDays * 86_400_000);
  const scopeWhere: Prisma.ObservationWhereInput = action.plantId
    ? { plantId: action.plantId }
    : action.zoneId
      ? { zoneId: action.zoneId }
      : { balconyId: action.balconyId };

  const [before, after] = await Promise.all([
    prisma.observation.findMany({
      where: { workspaceId: action.workspaceId, deletedAt: null, ...scopeWhere, observedAt: { gte: beforeFrom, lt: anchor } },
      orderBy: { observedAt: 'asc' },
    }),
    prisma.observation.findMany({
      where: { workspaceId: action.workspaceId, deletedAt: null, ...scopeWhere, observedAt: { gte: anchor, lt: afterTo } },
      orderBy: { observedAt: 'asc' },
    }),
  ]);

  const expectedBefore = Math.max(3, input.beforeDays * 2);
  const expectedAfter = Math.max(3, input.afterDays * 2);
  const coverageBefore = Math.min(1, before.length / expectedBefore);
  const coverageAfter = Math.min(1, after.length / expectedAfter);
  const comparable =
    before.length >= 3 &&
    after.length >= 3 &&
    coverageBefore >= 0.5 &&
    coverageAfter >= 0.5;

  const summarize = (rows: Observation[]) => {
    const temperatures = rows.map((item) => number(item.temperatureC));
    const statuses = rows.map((item) => item.plantStatus);
    const rank: Record<PlantStatus, number> = { HEALTHY: 0, WATCH: 1, CONCERN: 2, CRITICAL: 3 };
    const worst = statuses.sort((left, right) => rank[right] - rank[left])[0] ?? null;
    return {
      sampleCount: rows.length,
      temperature: {
        avg: round(mean(temperatures)),
        min: temperatures.length ? round(Math.min(...temperatures)) : null,
        max: temperatures.length ? round(Math.max(...temperatures)) : null,
      },
      lightDistribution: distribution(rows.map((item) => item.lightLevel)),
      windDistribution: distribution(rows.map((item) => item.windDirection)),
      plantStatus: {
        first: rows[0]?.plantStatus ?? null,
        last: rows.at(-1)?.plantStatus ?? null,
        worst,
        distribution: distribution(statuses),
      },
    };
  };

  const beforeSummary = summarize(before);
  const afterSummary = summarize(after);
  const temperatureDelta =
    beforeSummary.temperature.avg !== null && afterSummary.temperature.avg !== null
      ? round(afterSummary.temperature.avg - beforeSummary.temperature.avg)
      : null;

  const photos = await prisma.photo.findMany({
    where: {
      workspaceId: action.workspaceId,
      deletedAt: null,
      ...(action.plantId
        ? { plantId: action.plantId }
        : action.zoneId
          ? { zoneId: action.zoneId }
          : { balconyId: action.balconyId }),
      OR: [
        { capturedAt: { gte: beforeFrom, lt: afterTo } },
        { capturedAt: null, uploadedAt: { gte: beforeFrom, lt: afterTo } },
      ],
    },
    orderBy: [{ capturedAt: { sort: 'asc', nulls: 'last' } }, { uploadedAt: 'asc' }],
  });
  const photoTime = (photo: (typeof photos)[number]) => photo.capturedAt ?? photo.uploadedAt;
  const beforePhoto = [...photos].reverse().find((photo) => photoTime(photo) < anchor) ?? null;
  const afterPhoto = photos.find((photo) => photoTime(photo) >= anchor) ?? null;

  return {
    comparable,
    reason: comparable ? null : 'INSUFFICIENT_DATA',
    action: {
      id: action.id,
      type: action.actionType,
      title: action.title,
      startedAt: anchor.toISOString(),
      scope: action.plantId ? 'plant' : action.zoneId ? 'zone' : 'balcony',
    },
    window: {
      beforeFrom: beforeFrom.toISOString(),
      anchor: anchor.toISOString(),
      afterTo: afterTo.toISOString(),
      beforeDays: input.beforeDays,
      afterDays: input.afterDays,
    },
    coverage: {
      before: round(coverageBefore, 3),
      after: round(coverageAfter, 3),
      reference: '按每日至少 2 条记录估算，仅作为覆盖参考',
    },
    before: beforeSummary,
    after: afterSummary,
    temperatureDelta,
    photos: {
      before: beforePhoto,
      after: afterPhoto,
    },
    calculatedAt: new Date().toISOString(),
    disclaimer: '结果描述操作前后的样本变化，不代表已证明因果关系。',
  };
}

export async function buildDashboard(userId: string, workspaceId: string) {
  await requireWorkspaceRole(userId, workspaceId, 'VIEWER');
  const now = new Date();
  const since = new Date(now.getTime() - 7 * 86_400_000);
  const [latestObservation, observationCount, actionCount, upcomingReminders, attentionPlants, recentAction, workspace] =
    await Promise.all([
      prisma.observation.findFirst({
        where: { workspaceId, deletedAt: null },
        orderBy: { observedAt: 'desc' },
        include: { zone: true, plant: true },
      }),
      prisma.observation.count({ where: { workspaceId, deletedAt: null, observedAt: { gte: since } } }),
      prisma.actionLog.count({ where: { workspaceId, deletedAt: null, startedAt: { gte: since } } }),
      prisma.reminder.findMany({
        where: { workspaceId, userId, isActive: true, nextRunAt: { not: null } },
        orderBy: { nextRunAt: 'asc' },
        take: 5,
      }),
      prisma.plant.findMany({
        where: { workspaceId, archivedAt: null, status: { in: ['WATCH', 'CONCERN', 'CRITICAL'] } },
        orderBy: { updatedAt: 'desc' },
        take: 10,
        include: { zone: true },
      }),
      prisma.actionLog.findFirst({
        where: { workspaceId, deletedAt: null },
        orderBy: { startedAt: 'desc' },
      }),
      prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true, name: true } }),
    ]);

  return {
    workspace,
    latestObservation,
    last7Days: { observationCount, actionCount },
    upcomingReminders,
    attentionPlants,
    recentAction,
    dataFreshnessHours: latestObservation
      ? Math.max(0, Math.floor((now.getTime() - latestObservation.observedAt.getTime()) / 3_600_000))
      : null,
  };
}

export function metricIsValid(metric: string): metric is Metric {
  return ['temperature', 'light', 'wind', 'plant_status'].includes(metric);
}

export function bucketIsValid(bucket: string): bucket is Bucket {
  return ['raw', 'hour', 'day', 'week'].includes(bucket);
}

export function lightValue(value: LightLevel) {
  return value;
}

export function windValue(value: WindDirection) {
  return value;
}
