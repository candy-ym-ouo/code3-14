import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ianaTimezoneSchema } from '@balcony/shared';
import { prisma } from '../db.js';
import { requireAuth } from '../lib/auth.js';
import { AppError, parseOrThrow } from '../lib/errors.js';
import { requireWorkspaceRole } from '../services/authorization.js';
import { bucketIsValid, buildComparison, buildDashboard, buildSeries, metricIsValid } from '../services/analytics.js';

export async function analyticsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/analytics/summary', async (request) => {
    const query = parseOrThrow(z.object({ workspaceId: z.string().cuid() }), request.query);
    return buildDashboard(request.auth!.user.id, query.workspaceId);
  });

  app.get('/analytics/series', async (request) => {
    const query = parseOrThrow(
      z.object({
        workspaceId: z.string().cuid(),
        scope: z.enum(['workspace', 'balcony', 'zone', 'plant']),
        scopeId: z.string().cuid().optional(),
        metric: z.string(),
        from: z.string().datetime({ offset: true }),
        to: z.string().datetime({ offset: true }),
        bucket: z.enum(['raw', 'hour', 'day', 'week']).default('hour'),
        timezone: ianaTimezoneSchema.default(request.auth!.user.timezone),
      }).refine((value) => new Date(value.from) < new Date(value.to), {
        message: '开始时间必须早于结束时间',
        path: ['from'],
      }),
      request.query,
    );
    if (!metricIsValid(query.metric)) throw new AppError(422, 'INVALID_METRIC', '不支持的指标');
    if (query.scope !== 'workspace' && !query.scopeId) throw new AppError(422, 'SCOPE_ID_REQUIRED', '缺少对比对象 ID');
    const scope =
      query.scope === 'workspace'
        ? ({ type: 'workspace', workspaceId: query.workspaceId } as const)
        : query.scope === 'balcony'
          ? ({ type: 'balcony', workspaceId: query.workspaceId, balconyId: query.scopeId! } as const)
          : query.scope === 'zone'
            ? ({ type: 'zone', workspaceId: query.workspaceId, zoneId: query.scopeId! } as const)
            : ({ type: 'plant', workspaceId: query.workspaceId, plantId: query.scopeId! } as const);
    return buildSeries({
      userId: request.auth!.user.id,
      scope,
      metric: query.metric,
      from: new Date(query.from),
      to: new Date(query.to),
      bucket: query.bucket,
      timezone: query.timezone,
    });
  });

  app.get('/analytics/compare', async (request) => {
    const query = parseOrThrow(
      z.object({
        actionId: z.string().cuid(),
        beforeDays: z.coerce.number().int().min(1).max(90).default(7),
        afterDays: z.coerce.number().int().min(1).max(90).default(7),
      }),
      request.query,
    );
    return buildComparison({ userId: request.auth!.user.id, ...query });
  });

  app.get('/analytics/comparison-options', async (request) => {
    const query = parseOrThrow(z.object({ workspaceId: z.string().cuid(), plantId: z.string().cuid().optional() }), request.query);
    await requireWorkspaceRole(request.auth!.user.id, query.workspaceId, 'VIEWER');
    return prisma.actionLog.findMany({
      where: { workspaceId: query.workspaceId, deletedAt: null, plantId: query.plantId },
      select: {
        id: true,
        title: true,
        actionType: true,
        startedAt: true,
        plant: { select: { id: true, name: true } },
        zone: { select: { id: true, name: true } },
        _count: { select: { photos: true } },
      },
      orderBy: { startedAt: 'desc' },
      take: 100,
    });
  });
}
