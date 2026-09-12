import type { FastifyInstance } from 'fastify';
import { balconySchema, booleanQuerySchema, zoneSchema } from '@balcony/shared';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAuth } from '../lib/auth.js';
import { AppError, parseOrThrow } from '../lib/errors.js';
import { requireWorkspaceRole, workspaceIdForBalcony } from '../services/authorization.js';

export async function balconyRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/balconies', async (request) => {
    const query = parseOrThrow(z.object({ workspaceId: z.string().cuid(), includeArchived: booleanQuerySchema }), request.query);
    await requireWorkspaceRole(request.auth!.user.id, query.workspaceId, 'VIEWER');
    return prisma.balcony.findMany({
      where: { workspaceId: query.workspaceId, ...(query.includeArchived ? {} : { archivedAt: null }) },
      include: { zones: { where: { archivedAt: null }, orderBy: { sortOrder: 'asc' } }, _count: { select: { observations: true, zones: true } } },
      orderBy: { createdAt: 'asc' },
    });
  });

  app.post('/balconies', async (request, reply) => {
    const input = parseOrThrow(balconySchema, request.body);
    await requireWorkspaceRole(request.auth!.user.id, input.workspaceId, 'EDITOR');
    const balcony = await prisma.balcony.create({ data: input });
    return reply.status(201).send(balcony);
  });

  app.patch('/balconies/:id', async (request) => {
    const params = parseOrThrow(z.object({ id: z.string().cuid() }), request.params);
    const input = parseOrThrow(balconySchema.omit({ workspaceId: true }).partial(), request.body);
    await workspaceIdForBalcony(params.id, request.auth!.user.id, 'EDITOR');
    return prisma.balcony.update({ where: { id: params.id }, data: input });
  });

  app.delete('/balconies/:id', async (request, reply) => {
    const params = parseOrThrow(z.object({ id: z.string().cuid() }), request.params);
    await workspaceIdForBalcony(params.id, request.auth!.user.id, 'OWNER');
    const archivedAt = new Date();
    await prisma.$transaction(async (tx) => {
      const zones = await tx.zone.findMany({ where: { balconyId: params.id }, select: { id: true } });
      const zoneIds = zones.map((zone) => zone.id);
      const plants = zoneIds.length > 0
        ? await tx.plant.findMany({ where: { zoneId: { in: zoneIds } }, select: { id: true } })
        : [];
      const plantIds = plants.map((plant) => plant.id);
      await tx.balcony.update({ where: { id: params.id }, data: { archivedAt } });
      await tx.zone.updateMany({ where: { balconyId: params.id }, data: { archivedAt } });
      if (zoneIds.length > 0) {
        await tx.plant.updateMany({ where: { zoneId: { in: zoneIds } }, data: { archivedAt } });
      }
      await tx.reminder.updateMany({
        where: {
          isActive: true,
          OR: [
            { balconyId: params.id },
            ...(zoneIds.length > 0 ? [{ zoneId: { in: zoneIds } }] : []),
            ...(plantIds.length > 0 ? [{ plantId: { in: plantIds } }] : []),
          ],
        },
        data: { isActive: false, nextRunAt: null },
      });
    });
    return reply.status(204).send();
  });

  app.get('/balconies/:id/zones', async (request) => {
    const params = parseOrThrow(z.object({ id: z.string().cuid() }), request.params);
    await workspaceIdForBalcony(params.id, request.auth!.user.id, 'VIEWER');
    return prisma.zone.findMany({ where: { balconyId: params.id, archivedAt: null }, orderBy: { sortOrder: 'asc' } });
  });

  app.post('/balconies/:id/zones', async (request, reply) => {
    const params = parseOrThrow(z.object({ id: z.string().cuid() }), request.params);
    const input = parseOrThrow(zoneSchema.omit({ balconyId: true }), request.body);
    await workspaceIdForBalcony(params.id, request.auth!.user.id, 'EDITOR');
    const duplicate = await prisma.zone.findFirst({
      where: {
        balconyId: params.id,
        archivedAt: null,
        name: { equals: input.name, mode: 'insensitive' },
      },
      select: { id: true },
    });
    if (duplicate) throw new AppError(409, 'ZONE_NAME_EXISTS', '该阳台已存在同名位置');
    const zone = await prisma.zone.create({ data: { balconyId: params.id, ...input } });
    return reply.status(201).send(zone);
  });

  app.patch('/zones/:id', async (request) => {
    const params = parseOrThrow(z.object({ id: z.string().cuid() }), request.params);
    const input = parseOrThrow(zoneSchema.omit({ balconyId: true }).partial(), request.body);
    const zone = await prisma.zone.findUnique({ where: { id: params.id }, include: { balcony: true } });
    if (!zone) throw new AppError(404, 'ZONE_NOT_FOUND', '位置不存在');
    await requireWorkspaceRole(request.auth!.user.id, zone.balcony.workspaceId, 'EDITOR');
    if (input.name && input.name.toLocaleLowerCase() !== zone.name.toLocaleLowerCase()) {
      const duplicate = await prisma.zone.findFirst({
        where: {
          balconyId: zone.balconyId,
          archivedAt: null,
          id: { not: zone.id },
          name: { equals: input.name, mode: 'insensitive' },
        },
        select: { id: true },
      });
      if (duplicate) throw new AppError(409, 'ZONE_NAME_EXISTS', '该阳台已存在同名位置');
    }
    return prisma.zone.update({ where: { id: params.id }, data: input });
  });

  app.delete('/zones/:id', async (request, reply) => {
    const params = parseOrThrow(z.object({ id: z.string().cuid() }), request.params);
    const zone = await prisma.zone.findUnique({ where: { id: params.id }, include: { balcony: true } });
    if (!zone) throw new AppError(404, 'ZONE_NOT_FOUND', '位置不存在');
    await requireWorkspaceRole(request.auth!.user.id, zone.balcony.workspaceId, 'EDITOR');
    const activePlants = await prisma.plant.count({ where: { zoneId: params.id, archivedAt: null } });
    if (activePlants > 0) {
      throw new AppError(409, 'ZONE_HAS_PLANTS', '该位置仍有植物，请先搬动或归档植物');
    }
    await prisma.$transaction([
      prisma.zone.update({ where: { id: params.id }, data: { archivedAt: new Date() } }),
      prisma.reminder.updateMany({
        where: { zoneId: params.id, isActive: true },
        data: { isActive: false, nextRunAt: null },
      }),
    ]);
    return reply.status(204).send();
  });
}
