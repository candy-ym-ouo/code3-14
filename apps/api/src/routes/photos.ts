import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { requireAuth } from '../lib/auth.js';
import { AppError, parseOrThrow } from '../lib/errors.js';
import { createSignedObjectUrl } from '../storage.js';
import { requireWorkspaceRole } from '../services/authorization.js';
import { storePhoto } from '../services/photo-service.js';

function optionalDate(value?: string) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new AppError(422, 'INVALID_DATE', '日期格式不正确');
  if (date.getTime() > Date.now() + 5 * 60_000) {
    throw new AppError(422, 'FUTURE_PHOTO_TIME', '照片拍摄时间不能晚于当前时间 5 分钟');
  }
  return date;
}

type PhotoLinks = {
  workspaceId: string;
  observationId: string | null;
  actionLogId: string | null;
  plantId: string | null;
  zoneId: string | null;
};

async function validatePhotoLinks(links: PhotoLinks, options: { allowArchived?: boolean } = {}) {
  if (links.observationId && links.actionLogId) {
    throw new AppError(422, 'PHOTO_PRIMARY_LINK_CONFLICT', '照片不能同时关联观察记录和操作记录');
  }
  const [observation, action, plant, zone] = await Promise.all([
    links.observationId
      ? prisma.observation.findFirst({ where: { id: links.observationId, workspaceId: links.workspaceId, deletedAt: null } })
      : Promise.resolve(null),
    links.actionLogId
      ? prisma.actionLog.findFirst({ where: { id: links.actionLogId, workspaceId: links.workspaceId, deletedAt: null } })
      : Promise.resolve(null),
    links.plantId
      ? prisma.plant.findFirst({ where: { id: links.plantId, workspaceId: links.workspaceId, ...(options.allowArchived ? {} : { archivedAt: null }) } })
      : Promise.resolve(null),
    links.zoneId
      ? prisma.zone.findFirst({ where: { id: links.zoneId, ...(options.allowArchived ? {} : { archivedAt: null }) }, include: { balcony: true } })
      : Promise.resolve(null),
  ]);

  if (links.observationId && !observation) throw new AppError(422, 'OBSERVATION_MISMATCH', '观察记录不属于当前空间');
  if (links.actionLogId && !action) throw new AppError(422, 'ACTION_MISMATCH', '操作记录不属于当前空间');
  if (links.plantId && !plant) throw new AppError(422, 'PLANT_MISMATCH', '植物不属于当前空间');
  if (!links.observationId && !links.actionLogId && plant && zone && plant.zoneId !== zone.id) {
    throw new AppError(422, 'PHOTO_PLANT_ZONE_MISMATCH', '植物当前位置与照片位置不一致');
  }
  if (links.zoneId && (!zone || zone.balcony.workspaceId !== links.workspaceId)) {
    throw new AppError(422, 'ZONE_MISMATCH', '位置不属于当前空间');
  }
  if (!links.observationId && !links.actionLogId && !links.plantId && !links.zoneId) {
    throw new AppError(422, 'PHOTO_ASSOCIATION_REQUIRED', '照片至少需要关联观察、操作、植物或位置');
  }
}

export async function photoRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/photos', async (request) => {
    const query = parseOrThrow(
      z.object({
        cursor: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(20),
        workspaceId: z.string().cuid(),
        plantId: z.string().cuid().optional(),
        zoneId: z.string().cuid().optional(),
        observationId: z.string().cuid().optional(),
        actionLogId: z.string().cuid().optional(),
      }),
      request.query,
    );
    await requireWorkspaceRole(request.auth!.user.id, query.workspaceId, 'VIEWER');
    const rows = await prisma.photo.findMany({
      where: {
        workspaceId: query.workspaceId,
        deletedAt: null,
        plantId: query.plantId,
        zoneId: query.zoneId,
        observationId: query.observationId,
        actionLogId: query.actionLogId,
      },
      orderBy: [{ capturedAt: { sort: 'desc', nulls: 'last' } }, { uploadedAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > query.limit;
    const items = hasMore ? rows.slice(0, query.limit) : rows;
    return { items, nextCursor: hasMore ? items.at(-1)?.id ?? null : null };
  });

  app.get('/photos/compare-candidates', async (request) => {
    const query = parseOrThrow(
      z.object({
        workspaceId: z.string().cuid(),
        plantId: z.string().cuid().optional(),
        zoneId: z.string().cuid().optional(),
        around: z.string().datetime({ offset: true }).optional(),
        limit: z.coerce.number().int().min(2).max(100).default(40),
      }),
      request.query,
    );
    await requireWorkspaceRole(request.auth!.user.id, query.workspaceId, 'VIEWER');
    const around = query.around ? new Date(query.around) : null;
    return prisma.photo.findMany({
      where: {
        workspaceId: query.workspaceId,
        deletedAt: null,
        plantId: query.plantId,
        zoneId: query.zoneId,
        ...(around
          ? {
              OR: [
                { capturedAt: { gte: new Date(around.getTime() - 30 * 86_400_000), lte: new Date(around.getTime() + 30 * 86_400_000) } },
                { capturedAt: null, uploadedAt: { gte: new Date(around.getTime() - 30 * 86_400_000), lte: new Date(around.getTime() + 30 * 86_400_000) } },
              ],
            }
          : {}),
      },
      orderBy: [{ capturedAt: { sort: 'asc', nulls: 'last' } }, { uploadedAt: 'asc' }],
      take: query.limit,
    });
  });

  app.post('/photos/upload', async (request, reply) => {
    const fields: Record<string, string> = {};
    let file: { buffer: Buffer; filename: string } | null = null;
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        if (file) throw new AppError(422, 'TOO_MANY_FILES', '每次只能上传一张照片');
        const buffer = await part.toBuffer();
        if (buffer.length > config.UPLOAD_MAX_BYTES) throw new AppError(413, 'FILE_TOO_LARGE', '照片超过大小限制');
        file = { buffer, filename: part.filename };
      } else if (typeof part.value === 'string') {
        fields[part.fieldname] = part.value;
      }
    }
    if (!file) throw new AppError(422, 'FILE_REQUIRED', '请选择照片');

    const input = parseOrThrow(
      z.object({
        workspaceId: z.string().cuid(),
        observationId: z.string().cuid().nullable().optional(),
        actionLogId: z.string().cuid().nullable().optional(),
        plantId: z.string().cuid().nullable().optional(),
        zoneId: z.string().cuid().nullable().optional(),
        capturedAt: z.string().datetime({ offset: true }).nullable().optional(),
      }),
      fields,
    );
    await requireWorkspaceRole(request.auth!.user.id, input.workspaceId, 'EDITOR');

    let observationId = input.observationId ?? null;
    let actionLogId = input.actionLogId ?? null;
    let plantId = input.plantId ?? null;
    let zoneId = input.zoneId ?? null;
    if (observationId && actionLogId) {
      throw new AppError(422, 'PHOTO_PRIMARY_LINK_CONFLICT', '照片不能同时关联观察记录和操作记录');
    }
    if (observationId) {
      const observation = await prisma.observation.findFirst({ where: { id: observationId, workspaceId: input.workspaceId, deletedAt: null } });
      if (!observation) throw new AppError(422, 'OBSERVATION_MISMATCH', '观察记录不属于当前空间');
      if (plantId && observation.plantId && plantId !== observation.plantId) {
        throw new AppError(422, 'PHOTO_PLANT_MISMATCH', '照片植物与观察记录不一致');
      }
      if (zoneId && zoneId !== observation.zoneId) {
        throw new AppError(422, 'PHOTO_ZONE_MISMATCH', '照片位置与观察记录不一致');
      }
      plantId ??= observation.plantId;
      zoneId ??= observation.zoneId;
    }
    if (actionLogId) {
      const action = await prisma.actionLog.findFirst({ where: { id: actionLogId, workspaceId: input.workspaceId, deletedAt: null } });
      if (!action) throw new AppError(422, 'ACTION_MISMATCH', '操作记录不属于当前空间');
      if (plantId && action.plantId && plantId !== action.plantId) {
        throw new AppError(422, 'PHOTO_PLANT_MISMATCH', '照片植物与操作记录不一致');
      }
      if (zoneId && action.zoneId && zoneId !== action.zoneId) {
        throw new AppError(422, 'PHOTO_ZONE_MISMATCH', '照片位置与操作记录不一致');
      }
      plantId ??= action.plantId;
      zoneId ??= action.zoneId;
    }
    if (!observationId && !actionLogId && plantId && zoneId) {
      const plant = await prisma.plant.findFirst({ where: { id: plantId, workspaceId: input.workspaceId }, select: { zoneId: true } });
      if (plant && plant.zoneId !== zoneId) {
        throw new AppError(422, 'PHOTO_PLANT_ZONE_MISMATCH', '植物当前位置与照片位置不一致');
      }
    }
    const links = { workspaceId: input.workspaceId, observationId, actionLogId, plantId, zoneId };
    await validatePhotoLinks(links, { allowArchived: Boolean(observationId || actionLogId) });

    const photo = await storePhoto({
      ...links,
      uploadedBy: request.auth!.user.id,
      buffer: file.buffer,
      originalFilename: file.filename,
      capturedAt: optionalDate(input.capturedAt ?? undefined),
    });
    return reply.status(201).send(photo);
  });

  app.get('/photos/:id/url', async (request) => {
    const params = parseOrThrow(z.object({ id: z.string().uuid() }), request.params);
    const query = parseOrThrow(z.object({ variant: z.enum(['thumbnail', 'original']).default('thumbnail') }), request.query);
    const photo = await prisma.photo.findFirst({ where: { id: params.id, deletedAt: null } });
    if (!photo) throw new AppError(404, 'PHOTO_NOT_FOUND', '照片不存在');
    await requireWorkspaceRole(request.auth!.user.id, photo.workspaceId, 'VIEWER');
    const useThumbnail = query.variant === 'thumbnail' && Boolean(photo.thumbnailKey);
    const key = useThumbnail ? photo.thumbnailKey! : photo.objectKey;
    return {
      url: await createSignedObjectUrl(key, 600),
      expiresIn: 600,
      variant: useThumbnail ? 'thumbnail' : 'original',
      fallback: query.variant === 'thumbnail' && !useThumbnail,
    };
  });

  app.patch('/photos/:id', async (request) => {
    const params = parseOrThrow(z.object({ id: z.string().uuid() }), request.params);
    const photo = await prisma.photo.findFirst({ where: { id: params.id, deletedAt: null } });
    if (!photo) throw new AppError(404, 'PHOTO_NOT_FOUND', '照片不存在');
    await requireWorkspaceRole(request.auth!.user.id, photo.workspaceId, 'EDITOR');
    const input = parseOrThrow(
      z.object({
        capturedAt: z.string().datetime({ offset: true }).nullable().optional(),
        observationId: z.string().cuid().nullable().optional(),
        actionLogId: z.string().cuid().nullable().optional(),
        plantId: z.string().cuid().nullable().optional(),
        zoneId: z.string().cuid().nullable().optional(),
      }),
      request.body,
    );
    if (input.observationId && input.actionLogId) {
      throw new AppError(422, 'PHOTO_PRIMARY_LINK_CONFLICT', '照片不能同时关联观察记录和操作记录');
    }
    let observationId = input.observationId === undefined ? photo.observationId : input.observationId;
    let actionLogId = input.actionLogId === undefined ? photo.actionLogId : input.actionLogId;
    let plantId = input.plantId === undefined ? photo.plantId : input.plantId;
    let zoneId = input.zoneId === undefined ? photo.zoneId : input.zoneId;
    if (input.observationId && input.observationId !== photo.observationId) {
      const observation = await prisma.observation.findFirst({
        where: { id: input.observationId, workspaceId: photo.workspaceId, deletedAt: null },
      });
      if (!observation) throw new AppError(422, 'OBSERVATION_MISMATCH', '观察记录不属于当前空间');
      actionLogId = null;
      if (input.plantId === undefined) plantId = observation.plantId;
      if (input.zoneId === undefined) zoneId = observation.zoneId;
    }
    if (input.actionLogId && input.actionLogId !== photo.actionLogId) {
      const action = await prisma.actionLog.findFirst({
        where: { id: input.actionLogId, workspaceId: photo.workspaceId, deletedAt: null },
      });
      if (!action) throw new AppError(422, 'ACTION_MISMATCH', '操作记录不属于当前空间');
      observationId = null;
      if (input.plantId === undefined) plantId = action.plantId;
      if (input.zoneId === undefined) zoneId = action.zoneId;
    }
    const links = { workspaceId: photo.workspaceId, observationId, actionLogId, plantId, zoneId };
    await validatePhotoLinks(links);
    const capturedAt = input.capturedAt === undefined
      ? undefined
      : input.capturedAt === null
        ? null
        : optionalDate(input.capturedAt);
    const { workspaceId: _workspaceId, ...linkData } = links;
    return prisma.photo.update({
      where: { id: params.id },
      data: { ...linkData, capturedAt },
    });
  });

  app.delete('/photos/:id', async (request, reply) => {
    const params = parseOrThrow(z.object({ id: z.string().uuid() }), request.params);
    const photo = await prisma.photo.findFirst({ where: { id: params.id, deletedAt: null } });
    if (!photo) throw new AppError(404, 'PHOTO_NOT_FOUND', '照片不存在');
    await requireWorkspaceRole(request.auth!.user.id, photo.workspaceId, 'EDITOR');
    await prisma.$transaction([
      prisma.photo.update({ where: { id: params.id }, data: { deletedAt: new Date() } }),
      prisma.plant.updateMany({ where: { coverPhotoId: params.id }, data: { coverPhotoId: null } }),
    ]);
    return reply.status(204).send();
  });
}
