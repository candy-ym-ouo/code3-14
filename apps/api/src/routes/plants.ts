import type { FastifyInstance } from 'fastify';
import { booleanQuerySchema, plantSchema } from '@balcony/shared';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAuth } from '../lib/auth.js';
import { AppError, parseOrThrow } from '../lib/errors.js';
import { requireWorkspaceRole, workspaceIdForPlant } from '../services/authorization.js';

export async function plantRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/plants', async (request) => {
    const query = parseOrThrow(
      z.object({
        workspaceId: z.string().cuid(),
        zoneId: z.string().cuid().optional(),
        includeArchived: booleanQuerySchema,
      }),
      request.query,
    );
    await requireWorkspaceRole(request.auth!.user.id, query.workspaceId, 'VIEWER');
    return prisma.plant.findMany({
      where: {
        workspaceId: query.workspaceId,
        zoneId: query.zoneId,
        ...(query.includeArchived ? {} : { archivedAt: null }),
      },
      include: { zone: true, coverPhoto: true, _count: { select: { observations: true, actionLogs: true } } },
      orderBy: { createdAt: 'asc' },
    });
  });

  app.post('/plants', async (request, reply) => {
    const input = parseOrThrow(plantSchema, request.body);
    await requireWorkspaceRole(request.auth!.user.id, input.workspaceId, 'EDITOR');
    const zone = await prisma.zone.findUnique({ where: { id: input.zoneId }, include: { balcony: true } });
    if (!zone || zone.archivedAt || zone.balcony.workspaceId !== input.workspaceId) {
      throw new AppError(422, 'ZONE_MISMATCH', '位置不属于当前空间');
    }
    const acquiredAt = input.acquiredAt ? new Date(input.acquiredAt) : null;
    if (acquiredAt && acquiredAt.getTime() > Date.now() + 5 * 60_000) {
      throw new AppError(422, 'FUTURE_ACQUIRED_AT', '获取时间不能晚于当前时间');
    }
    const plant = await prisma.plant.create({ data: { ...input, acquiredAt } });
    return reply.status(201).send(plant);
  });

  app.get('/plants/:id', async (request) => {
    const params = parseOrThrow(z.object({ id: z.string().cuid() }), request.params);
    await workspaceIdForPlant(params.id, request.auth!.user.id, 'VIEWER');
    const plant = await prisma.plant.findUnique({
      where: { id: params.id },
      include: {
        zone: { include: { balcony: true } },
        coverPhoto: true,
        zoneHistory: { orderBy: { movedAt: 'desc' } },
        observations: { where: { deletedAt: null }, orderBy: { observedAt: 'desc' }, take: 50, include: { photos: true, zone: true } },
        actionLogs: { where: { deletedAt: null }, orderBy: { startedAt: 'desc' }, take: 50, include: { photos: true } },
        reminders: { where: { isActive: true }, orderBy: { nextRunAt: 'asc' } },
      },
    });
    if (!plant) throw new AppError(404, 'PLANT_NOT_FOUND', '植物不存在');
    return plant;
  });

  app.patch('/plants/:id', async (request) => {
    const params = parseOrThrow(z.object({ id: z.string().cuid() }), request.params);
    const input = parseOrThrow(plantSchema.omit({ workspaceId: true }).partial(), request.body);
    const plant = await prisma.plant.findUnique({ where: { id: params.id } });
    if (!plant) throw new AppError(404, 'PLANT_NOT_FOUND', '植物不存在');
    if (plant.archivedAt) throw new AppError(409, 'PLANT_ARCHIVED', '已归档植物不能修改');
    await requireWorkspaceRole(request.auth!.user.id, plant.workspaceId, 'EDITOR');
    const acquiredAt = input.acquiredAt ? new Date(input.acquiredAt) : undefined;
    if (acquiredAt && acquiredAt.getTime() > Date.now() + 5 * 60_000) {
      throw new AppError(422, 'FUTURE_ACQUIRED_AT', '获取时间不能晚于当前时间');
    }
    if (input.zoneId) {
      const zone = await prisma.zone.findUnique({ where: { id: input.zoneId }, include: { balcony: true } });
      if (!zone || zone.archivedAt || zone.balcony.workspaceId !== plant.workspaceId) {
        throw new AppError(422, 'ZONE_MISMATCH', '位置不属于当前空间');
      }
    }
    return prisma.$transaction(async (tx) => {
      if (input.zoneId && input.zoneId !== plant.zoneId) {
        await tx.plantZoneHistory.create({
          data: {
            plantId: plant.id,
            fromZoneId: plant.zoneId,
            toZoneId: input.zoneId,
            movedAt: new Date(),
          },
        });
      }
      return tx.plant.update({
        where: { id: params.id },
        data: { ...input, acquiredAt },
      });
    });
  });

  app.post('/plants/:id/move', async (request) => {
    const params = parseOrThrow(z.object({ id: z.string().cuid() }), request.params);
    const input = parseOrThrow(z.object({ toZoneId: z.string().cuid(), movedAt: z.string().datetime({ offset: true }).optional() }), request.body);
    const plant = await prisma.plant.findUnique({ where: { id: params.id } });
    if (!plant) throw new AppError(404, 'PLANT_NOT_FOUND', '植物不存在');
    if (plant.archivedAt) throw new AppError(409, 'PLANT_ARCHIVED', '已归档植物不能搬动');
    await requireWorkspaceRole(request.auth!.user.id, plant.workspaceId, 'EDITOR');
    const zone = await prisma.zone.findUnique({ where: { id: input.toZoneId }, include: { balcony: true } });
    if (!zone || zone.archivedAt || zone.balcony.workspaceId !== plant.workspaceId) throw new AppError(422, 'ZONE_MISMATCH', '位置不属于当前空间');
    if (plant.zoneId === zone.id) return plant;
    const movedAt = input.movedAt ? new Date(input.movedAt) : new Date();
    if (movedAt.getTime() > Date.now() + 5 * 60_000) {
      throw new AppError(422, 'FUTURE_MOVE', '搬动时间不能晚于当前时间 5 分钟');
    }
    return prisma.$transaction(async (tx) => {
      await tx.plantZoneHistory.create({ data: { plantId: plant.id, fromZoneId: plant.zoneId, toZoneId: zone.id, movedAt } });
      return tx.plant.update({ where: { id: plant.id }, data: { zoneId: zone.id } });
    });
  });

  app.delete('/plants/:id', async (request, reply) => {
    const params = parseOrThrow(z.object({ id: z.string().cuid() }), request.params);
    await workspaceIdForPlant(params.id, request.auth!.user.id, 'EDITOR');
    await prisma.$transaction([
      prisma.plant.update({ where: { id: params.id }, data: { archivedAt: new Date() } }),
      prisma.reminder.updateMany({
        where: { plantId: params.id, isActive: true },
        data: { isActive: false, nextRunAt: null },
      }),
    ]);
    return reply.status(204).send();
  });
}
