import type { FastifyInstance } from 'fastify';
import { stageCorrectionSchema, stageRollbackSchema } from '@balcony/shared';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAuth } from '../lib/auth.js';
import { AppError, parseOrThrow } from '../lib/errors.js';
import { workspaceIdForPlant } from '../services/authorization.js';
import {
  applyManualStageCorrection,
  getPlantStageTimeline,
  recomputePlantStage,
  rollbackPlantStage,
} from '../services/growth-stage.js';
import { enqueueJob } from '../queue.js';

export async function plantStageRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  // 阶段时间线：当前阶段、人工锚点、全部事件（含已失效事件与原因链字段）
  app.get('/plants/:id/stages', async (request) => {
    const params = parseOrThrow(z.object({ id: z.string().cuid() }), request.params);
    await workspaceIdForPlant(params.id, request.auth!.user.id, 'VIEWER');
    return getPlantStageTimeline(params.id);
  });

  // 用最新时间序列证据重新推断（不改变任何人工判断）
  app.post('/plants/:id/stages/recompute', async (request) => {
    const params = parseOrThrow(z.object({ id: z.string().cuid() }), request.params);
    const workspaceId = await workspaceIdForPlant(params.id, request.auth!.user.id, 'EDITOR');
    const result = await recomputePlantStage(params.id);
    return { changed: result.changed, current: result.event, workspaceId };
  });

  // 人工修正：成为锚点，自动推断不可覆盖
  app.post('/plants/:id/stages/corrections', async (request, reply) => {
    const params = parseOrThrow(z.object({ id: z.string().cuid() }), request.params);
    const input = parseOrThrow(stageCorrectionSchema, request.body);
    const workspaceId = await workspaceIdForPlant(params.id, request.auth!.user.id, 'EDITOR');
    const event = await applyManualStageCorrection({
      plantId: params.id,
      userId: request.auth!.user.id,
      stage: input.stage,
      validFrom: input.validFrom ? new Date(input.validFrom) : undefined,
      reason: input.reason,
    });
    await prisma.auditLog.create({
      data: {
        workspaceId,
        actorUserId: request.auth!.user.id,
        action: 'plant_stage.correction',
        entityType: 'PlantStageEvent',
        entityId: event.id,
        afterJson: { stage: event.stage, validFrom: event.validFrom.toISOString(), reason: event.reason },
      },
    });
    await enqueueJob('plant-stage.recompute', { plantId: params.id });
    return reply.status(201).send(event);
  });

  // 回退：追加 ROLLBACK 事件并保留原因链，不删除任何历史事件
  app.post('/plants/:id/stages/rollback', async (request, reply) => {
    const params = parseOrThrow(z.object({ id: z.string().cuid() }), request.params);
    const input = parseOrThrow(stageRollbackSchema, request.body);
    const workspaceId = await workspaceIdForPlant(params.id, request.auth!.user.id, 'EDITOR');
    const target = await prisma.plantStageEvent.findFirst({ where: { id: input.eventId, plantId: params.id } });
    if (!target) throw new AppError(404, 'STAGE_EVENT_NOT_FOUND', '阶段事件不存在');
    const event = await rollbackPlantStage({
      plantId: params.id,
      userId: request.auth!.user.id,
      eventId: input.eventId,
      reason: input.reason,
    });
    await prisma.auditLog.create({
      data: {
        workspaceId,
        actorUserId: request.auth!.user.id,
        action: 'plant_stage.rollback',
        entityType: 'PlantStageEvent',
        entityId: event.id,
        afterJson: {
          stage: event.stage,
          rollbackToEventId: input.eventId,
          reason: input.reason,
        },
      },
    });
    await enqueueJob('plant-stage.recompute', { plantId: params.id });
    return reply.status(201).send(event);
  });
}
