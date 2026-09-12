import type { FastifyInstance } from 'fastify';
import { booleanQuerySchema } from '@balcony/shared';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAuth } from '../lib/auth.js';
import { parseOrThrow } from '../lib/errors.js';

export async function notificationRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/notifications', async (request) => {
    const query = parseOrThrow(
      z.object({
        unreadOnly: booleanQuerySchema,
        limit: z.coerce.number().int().min(1).max(100).default(30),
      }),
      request.query,
    );
    return prisma.notification.findMany({
      where: { userId: request.auth!.user.id, channel: 'IN_APP', ...(query.unreadOnly ? { readAt: null } : {}) },
      orderBy: { createdAt: 'desc' },
      take: query.limit,
    });
  });

  app.post('/notifications/read', async (request) => {
    const input = parseOrThrow(z.object({ ids: z.array(z.string().cuid()).min(1).max(100) }), request.body);
    await prisma.notification.updateMany({
      where: { id: { in: input.ids }, userId: request.auth!.user.id, channel: 'IN_APP' },
      data: { readAt: new Date(), status: 'READ' },
    });
    return { ok: true };
  });

  app.post('/notifications/read-all', async (request) => {
    await prisma.notification.updateMany({
      where: { userId: request.auth!.user.id, channel: 'IN_APP', readAt: null },
      data: { readAt: new Date(), status: 'READ' },
    });
    return { ok: true };
  });
}
