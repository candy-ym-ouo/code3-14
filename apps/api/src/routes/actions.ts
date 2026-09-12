import type { FastifyInstance } from 'fastify';
import { actionSchema, paginationSchema } from '@balcony/shared';
import { z } from 'zod';
import { Prisma, type ActionLog } from '@prisma/client';
import { prisma } from '../db.js';
import { requireAuth } from '../lib/auth.js';
import { AppError, parseOrThrow } from '../lib/errors.js';
import { requireWorkspaceRole } from '../services/authorization.js';
import { resolvePlantZoneAtTime } from '../services/plant-location.js';

async function validateActionAssociations(input: {
  workspaceId: string;
  balconyId: string;
  zoneId?: string | null;
  plantId?: string | null;
  actionType: string;
  startedAt: string;
}) {
  const balcony = await prisma.balcony.findFirst({ where: { id: input.balconyId, workspaceId: input.workspaceId, archivedAt: null } });
  if (!balcony) throw new AppError(422, 'BALCONY_MISMATCH', '阳台不属于当前空间');
  if (input.zoneId) {
    const zone = await prisma.zone.findFirst({ where: { id: input.zoneId, balconyId: input.balconyId, archivedAt: null } });
    if (!zone) throw new AppError(422, 'ZONE_MISMATCH', '位置不属于所选阳台');
  }
  if (input.plantId) {
    const plant = await prisma.plant.findFirst({ where: { id: input.plantId, workspaceId: input.workspaceId, archivedAt: null } });
    if (!plant) throw new AppError(422, 'PLANT_MISMATCH', '植物不属于当前空间');
    if (input.zoneId) {
      const historicalZoneId = await resolvePlantZoneAtTime(plant.id, new Date(input.startedAt));
      if (input.actionType === 'MOVE') {
        if (historicalZoneId === input.zoneId) {
          throw new AppError(422, 'MOVE_TARGET_UNCHANGED', '目标位置不能与植物执行前的位置相同');
        }
      } else if (historicalZoneId !== input.zoneId) {
        throw new AppError(422, 'PLANT_ZONE_MISMATCH', '植物在执行时间并不位于所选位置');
      }
    }
  }
}

export async function actionRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/actions', async (request) => {
    const query = parseOrThrow(
      paginationSchema.extend({
        workspaceId: z.string().cuid(),
        plantId: z.string().cuid().optional(),
        zoneId: z.string().cuid().optional(),
        type: z.enum(['SHADE', 'WATER', 'REPOT', 'MOVE', 'FERTILIZE', 'PRUNE', 'CUSTOM']).optional(),
      }),
      request.query,
    );
    await requireWorkspaceRole(request.auth!.user.id, query.workspaceId, 'VIEWER');
    const rows = await prisma.actionLog.findMany({
      where: { workspaceId: query.workspaceId, deletedAt: null, plantId: query.plantId, zoneId: query.zoneId, actionType: query.type },
      include: { zone: true, plant: true, photos: { where: { deletedAt: null } } },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > query.limit;
    const items = hasMore ? rows.slice(0, query.limit) : rows;
    return { items, nextCursor: hasMore ? items.at(-1)?.id ?? null : null };
  });

  app.get('/actions/:id', async (request) => {
    const params = parseOrThrow(z.object({ id: z.string().cuid() }), request.params);
    const action = await prisma.actionLog.findFirst({
      where: { id: params.id, deletedAt: null },
      include: { balcony: true, zone: true, plant: true, photos: { where: { deletedAt: null } } },
    });
    if (!action) throw new AppError(404, 'ACTION_NOT_FOUND', '操作记录不存在');
    await requireWorkspaceRole(request.auth!.user.id, action.workspaceId, 'VIEWER');
    return action;
  });

  app.post('/actions', async (request, reply) => {
    const input = parseOrThrow(actionSchema, request.body);
    await requireWorkspaceRole(request.auth!.user.id, input.workspaceId, 'EDITOR');
    if (input.actionType === 'MOVE' && (!input.plantId || !input.zoneId)) {
      throw new AppError(422, 'MOVE_TARGET_REQUIRED', '搬动操作必须选择植物和目标位置');
    }
    const startedAt = new Date(input.startedAt);
    const completedAt = input.completedAt ? new Date(input.completedAt) : null;
    await validateActionAssociations({ ...input, startedAt: input.startedAt });
    if (input.clientRequestId) {
      const existing = await prisma.actionLog.findFirst({ where: { createdBy: request.auth!.user.id, clientRequestId: input.clientRequestId } });
      if (existing) return reply.status(200).send(existing);
    }
    if (startedAt.getTime() > Date.now() + 5 * 60_000 || (completedAt && completedAt.getTime() > Date.now() + 5 * 60_000)) {
      throw new AppError(422, 'FUTURE_ACTION', '操作时间不能晚于当前时间 5 分钟');
    }
    if (completedAt && completedAt < startedAt) {
      throw new AppError(422, 'INVALID_ACTION_TIME', '完成时间不能早于开始时间');
    }
    let action: ActionLog;
    try {
      action = await prisma.$transaction(async (tx) => {
      const created = await tx.actionLog.create({
        data: {
          workspaceId: input.workspaceId,
          balconyId: input.balconyId,
          zoneId: input.zoneId ?? null,
          plantId: input.plantId ?? null,
          actionType: input.actionType,
          title: input.title,
          startedAt,
          completedAt,
          parametersJson: input.parameters as Prisma.InputJsonValue,
          notes: input.notes ?? null,
          clientRequestId: input.clientRequestId ?? null,
          createdBy: request.auth!.user.id,
        },
      });
      if (input.actionType === 'MOVE' && input.plantId && input.zoneId) {
        const plant = await tx.plant.findUniqueOrThrow({ where: { id: input.plantId } });
        if (plant.zoneId !== input.zoneId) {
          await tx.plantZoneHistory.create({
            data: { plantId: plant.id, fromZoneId: plant.zoneId, toZoneId: input.zoneId, movedAt: startedAt, actionLogId: created.id },
          });
          await tx.plant.update({ where: { id: plant.id }, data: { zoneId: input.zoneId } });
        }
      }
      return created;
      });
    } catch (error) {
      if (input.clientRequestId && error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const existing = await prisma.actionLog.findFirst({
          where: { createdBy: request.auth!.user.id, clientRequestId: input.clientRequestId },
        });
        if (existing) return reply.status(200).send(existing);
      }
      throw error;
    }
    return reply.status(201).send(action);
  });

  app.patch('/actions/:id', async (request) => {
    const params = parseOrThrow(z.object({ id: z.string().cuid() }), request.params);
    const existing = await prisma.actionLog.findFirst({ where: { id: params.id, deletedAt: null } });
    if (!existing) throw new AppError(404, 'ACTION_NOT_FOUND', '操作记录不存在');
    await requireWorkspaceRole(request.auth!.user.id, existing.workspaceId, 'EDITOR');
    const input = parseOrThrow(actionSchema.omit({ workspaceId: true, balconyId: true, zoneId: true, plantId: true, clientRequestId: true }).partial(), request.body);
    if (existing.actionType === 'MOVE' && input.startedAt !== undefined) {
      throw new AppError(409, 'MOVE_TIME_IMMUTABLE', '搬动记录的执行时间不能修改');
    }
    const startedAt = input.startedAt ? new Date(input.startedAt) : existing.startedAt;
    if (input.startedAt !== undefined && existing.actionType !== 'MOVE' && existing.plantId && existing.zoneId) {
      const zoneAtStartedTime = await resolvePlantZoneAtTime(existing.plantId, startedAt);
      if (zoneAtStartedTime !== existing.zoneId) {
        throw new AppError(422, 'PLANT_ZONE_MISMATCH', '植物在执行时间并不位于该操作记录的位置');
      }
    }
    const completedAt = input.completedAt === null
      ? null
      : input.completedAt
        ? new Date(input.completedAt)
        : existing.completedAt;
    if (startedAt.getTime() > Date.now() + 5 * 60_000 || (completedAt && completedAt.getTime() > Date.now() + 5 * 60_000)) {
      throw new AppError(422, 'FUTURE_ACTION', '操作时间不能晚于当前时间 5 分钟');
    }
    if (completedAt && completedAt < startedAt) {
      throw new AppError(422, 'INVALID_ACTION_TIME', '完成时间不能早于开始时间');
    }
    return prisma.$transaction(async (tx) => {
      const updated = await tx.actionLog.update({
        where: { id: params.id },
        data: {
          ...input,
          startedAt,
          completedAt,
          parametersJson: input.parameters as Prisma.InputJsonValue | undefined,
          notes: input.notes === null ? null : input.notes,
        },
      });
      return updated;
    });
  });

  app.delete('/actions/:id', async (request, reply) => {
    const params = parseOrThrow(z.object({ id: z.string().cuid() }), request.params);
    const existing = await prisma.actionLog.findFirst({ where: { id: params.id, deletedAt: null } });
    if (!existing) throw new AppError(404, 'ACTION_NOT_FOUND', '操作记录不存在');
    await requireWorkspaceRole(request.auth!.user.id, existing.workspaceId, 'EDITOR');
    if (existing.actionType === 'MOVE') {
      throw new AppError(409, 'MOVE_ACTION_IMMUTABLE', '搬动记录不能删除；请通过新的搬动记录更正位置');
    }
    const deletedAt = new Date();
    await prisma.$transaction([
      prisma.plant.updateMany({
        where: { coverPhoto: { actionLogId: params.id } },
        data: { coverPhotoId: null },
      }),
      prisma.actionLog.update({ where: { id: params.id }, data: { deletedAt } }),
      prisma.photo.updateMany({
        where: { actionLogId: params.id, deletedAt: null },
        data: { deletedAt },
      }),
    ]);
    return reply.status(204).send();
  });
}
