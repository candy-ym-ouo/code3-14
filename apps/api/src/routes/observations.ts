import type { FastifyInstance } from 'fastify';
import { observationSchema, paginationSchema } from '@balcony/shared';
import { z } from 'zod';
import { Prisma, type Observation } from '@prisma/client';
import { prisma } from '../db.js';
import { requireAuth } from '../lib/auth.js';
import { AppError, parseOrThrow } from '../lib/errors.js';
import { requireWorkspaceRole } from '../services/authorization.js';
import { enqueueJob } from '../queue.js';
import { resolvePlantZoneAtTime } from '../services/plant-location.js';

async function refreshPlantStatus(tx: Prisma.TransactionClient, plantId: string) {
  const latest = await tx.observation.findFirst({
    where: { plantId, deletedAt: null },
    orderBy: [{ observedAt: 'desc' }, { createdAt: 'desc' }],
    select: { plantStatus: true },
  });
  await tx.plant.update({
    where: { id: plantId },
    data: { status: latest?.plantStatus ?? 'HEALTHY' },
  });
}

async function validateAssociations(input: {
  workspaceId: string;
  balconyId: string;
  zoneId: string;
  plantId?: string | null;
  observedAt: string;
}) {
  const [balcony, zone, plant] = await Promise.all([
    prisma.balcony.findFirst({ where: { id: input.balconyId, workspaceId: input.workspaceId, archivedAt: null } }),
    prisma.zone.findFirst({ where: { id: input.zoneId, archivedAt: null }, include: { balcony: true } }),
    input.plantId
      ? prisma.plant.findFirst({ where: { id: input.plantId, workspaceId: input.workspaceId, archivedAt: null }, select: { id: true, zoneId: true } })
      : Promise.resolve(null),
  ]);
  if (!balcony) throw new AppError(422, 'BALCONY_MISMATCH', '阳台不属于当前空间');
  if (!zone || zone.balconyId !== input.balconyId || zone.balcony.workspaceId !== input.workspaceId) {
    throw new AppError(422, 'ZONE_MISMATCH', '位置不属于所选阳台');
  }
  if (input.plantId && !plant) throw new AppError(422, 'PLANT_MISMATCH', '植物不属于当前空间');
  if (input.plantId) {
    const historicalZoneId = await resolvePlantZoneAtTime(input.plantId, new Date(input.observedAt));
    if (historicalZoneId !== input.zoneId) {
      throw new AppError(422, 'PLANT_ZONE_MISMATCH', '植物在观察时间并不位于所选位置');
    }
  }
}

export async function observationRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/observations', async (request) => {
    const query = parseOrThrow(
      paginationSchema.extend({
        workspaceId: z.string().cuid(),
        balconyId: z.string().cuid().optional(),
        zoneId: z.string().cuid().optional(),
        plantId: z.string().cuid().optional(),
        from: z.string().datetime({ offset: true }).optional(),
        to: z.string().datetime({ offset: true }).optional(),
      }),
      request.query,
    );
    await requireWorkspaceRole(request.auth!.user.id, query.workspaceId, 'VIEWER');
    const rows = await prisma.observation.findMany({
      where: {
        workspaceId: query.workspaceId,
        deletedAt: null,
        balconyId: query.balconyId,
        zoneId: query.zoneId,
        plantId: query.plantId,
        observedAt: query.from || query.to ? { gte: query.from ? new Date(query.from) : undefined, lt: query.to ? new Date(query.to) : undefined } : undefined,
      },
      include: { zone: true, plant: true, photos: { where: { deletedAt: null } } },
      orderBy: [{ observedAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > query.limit;
    const items = hasMore ? rows.slice(0, query.limit) : rows;
    return { items, nextCursor: hasMore ? items.at(-1)?.id ?? null : null };
  });

  app.get('/observations/:id', async (request) => {
    const params = parseOrThrow(z.object({ id: z.string().cuid() }), request.params);
    const observation = await prisma.observation.findFirst({
      where: { id: params.id, deletedAt: null },
      include: { zone: true, plant: true, balcony: true, photos: { where: { deletedAt: null } } },
    });
    if (!observation) throw new AppError(404, 'OBSERVATION_NOT_FOUND', '观察记录不存在');
    await requireWorkspaceRole(request.auth!.user.id, observation.workspaceId, 'VIEWER');
    return observation;
  });

  app.post('/observations', async (request, reply) => {
    const input = parseOrThrow(observationSchema, request.body);
    await requireWorkspaceRole(request.auth!.user.id, input.workspaceId, 'EDITOR');
    const observedAt = new Date(input.observedAt);
    if (observedAt.getTime() > Date.now() + 5 * 60_000) {
      throw new AppError(422, 'FUTURE_OBSERVATION', '观察时间不能晚于当前时间 5 分钟');
    }
    await validateAssociations(input);
    if (input.clientRequestId) {
      const existing = await prisma.observation.findFirst({ where: { createdBy: request.auth!.user.id, clientRequestId: input.clientRequestId } });
      if (existing) {
        await enqueueJob('reminder.threshold', { observationId: existing.id }, { jobId: `threshold-${existing.id}` });
        return reply.status(200).send(existing);
      }
    }

    let observation: Observation;
    try {
      observation = await prisma.$transaction(async (tx) => {
        const created = await tx.observation.create({
          data: {
            workspaceId: input.workspaceId,
            balconyId: input.balconyId,
            zoneId: input.zoneId,
            plantId: input.plantId ?? null,
            observedAt,
            temperatureC: input.temperatureC,
            lightLevel: input.lightLevel,
            lux: input.lux ?? null,
            windDirection: input.windDirection,
            windDegrees: input.windDegrees ?? null,
            windSpeedMps: input.windSpeedMps ?? null,
            plantStatus: input.plantStatus,
            plantTags: input.plantTags,
            soilMoisturePct: input.soilMoisturePct ?? null,
            soilMoistureSource: input.soilMoistureSource ?? null,
            notes: input.notes ?? null,
            clientRequestId: input.clientRequestId ?? null,
            createdBy: request.auth!.user.id,
          },
        });
        if (input.plantId) {
          await refreshPlantStatus(tx, input.plantId);
        }
        return created;
      });
    } catch (error) {
      if (input.clientRequestId && error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const existing = await prisma.observation.findFirst({
          where: { createdBy: request.auth!.user.id, clientRequestId: input.clientRequestId },
        });
        if (existing) {
          await enqueueJob('reminder.threshold', { observationId: existing.id }, { jobId: `threshold-${existing.id}` });
          return reply.status(200).send(existing);
        }
      }
      throw error;
    }
    await enqueueJob('reminder.threshold', { observationId: observation.id }, { jobId: `threshold-${observation.id}` });
    return reply.status(201).send(observation);
  });

  app.patch('/observations/:id', async (request) => {
    const params = parseOrThrow(z.object({ id: z.string().cuid() }), request.params);
    const existing = await prisma.observation.findFirst({ where: { id: params.id, deletedAt: null } });
    if (!existing) throw new AppError(404, 'OBSERVATION_NOT_FOUND', '观察记录不存在');
    await requireWorkspaceRole(request.auth!.user.id, existing.workspaceId, 'EDITOR');
    const input = parseOrThrow(observationSchema.omit({ workspaceId: true, balconyId: true, zoneId: true, clientRequestId: true }).partial(), request.body);
    const observedAt = input.observedAt ? new Date(input.observedAt) : undefined;
    if (observedAt && observedAt.getTime() > Date.now() + 5 * 60_000) {
      throw new AppError(422, 'FUTURE_OBSERVATION', '观察时间不能晚于当前时间 5 分钟');
    }
    const effectivePlantId = input.plantId === undefined ? existing.plantId : input.plantId;
    if (effectivePlantId) {
      const plant = await prisma.plant.findFirst({
        where: { id: effectivePlantId, workspaceId: existing.workspaceId },
        select: { id: true },
      });
      const zoneAtObservedTime = plant
        ? await resolvePlantZoneAtTime(plant.id, observedAt ?? existing.observedAt)
        : null;
      if (!plant || zoneAtObservedTime !== existing.zoneId) {
        throw new AppError(422, 'PLANT_ZONE_MISMATCH', '植物在观察时间并不位于该记录的位置');
      }
    }
    const updated = await prisma.$transaction(async (tx) => {
      const current = await tx.observation.update({
        where: { id: params.id },
        data: {
          ...input,
          observedAt,
          notes: input.notes === null ? null : input.notes,
        },
      });
      const plantChanged = input.plantId !== undefined && input.plantId !== existing.plantId;
      if (plantChanged && existing.plantId) {
        await refreshPlantStatus(tx, existing.plantId);
      }
      const affectedPlantId = input.plantId === undefined ? existing.plantId : input.plantId;
      if (affectedPlantId && (plantChanged || input.plantStatus !== undefined || input.observedAt !== undefined)) {
        await refreshPlantStatus(tx, affectedPlantId);
      }
      return current;
    });
    if (
      input.temperatureC !== undefined ||
      input.plantStatus !== undefined ||
      input.observedAt !== undefined ||
      input.plantId !== undefined
    ) {
      await enqueueJob(
        'reminder.threshold',
        { observationId: updated.id },
        { jobId: `threshold-${updated.id}-${updated.updatedAt.getTime()}` },
      );
    }
    return updated;
  });

  app.delete('/observations/:id', async (request, reply) => {
    const params = parseOrThrow(z.object({ id: z.string().cuid() }), request.params);
    const existing = await prisma.observation.findFirst({ where: { id: params.id, deletedAt: null } });
    if (!existing) throw new AppError(404, 'OBSERVATION_NOT_FOUND', '观察记录不存在');
    await requireWorkspaceRole(request.auth!.user.id, existing.workspaceId, 'EDITOR');
    await prisma.$transaction(async (tx) => {
      const deletedAt = new Date();
      await tx.observation.update({ where: { id: params.id }, data: { deletedAt } });
      await tx.plant.updateMany({
        where: { coverPhoto: { observationId: params.id } },
        data: { coverPhotoId: null },
      });
      await tx.photo.updateMany({
        where: { observationId: params.id, deletedAt: null },
        data: { deletedAt },
      });
      if (existing.plantId) {
        const latest = await tx.observation.findFirst({
          where: { plantId: existing.plantId, deletedAt: null },
          orderBy: { observedAt: 'desc' },
          select: { plantStatus: true },
        });
        await tx.plant.update({
          where: { id: existing.plantId },
          data: { status: latest?.plantStatus ?? 'HEALTHY' },
        });
      }
    });
    return reply.status(204).send();
  });
}
