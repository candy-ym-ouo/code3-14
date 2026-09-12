import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAuth, verifyPassword } from '../lib/auth.js';
import { AppError, parseOrThrow } from '../lib/errors.js';
import { enqueueJob } from '../queue.js';
import { createSignedObjectUrl } from '../storage.js';

export async function userRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.post('/users/me/export', async (request, reply) => {
    const job = await prisma.exportJob.create({ data: { userId: request.auth!.user.id } });
    await enqueueJob('export.generate', { exportId: job.id, userId: request.auth!.user.id }, { jobId: `export-${job.id}` });
    return reply.status(202).send(job);
  });

  app.get('/users/me/exports', async (request) => {
    return prisma.exportJob.findMany({
      where: { userId: request.auth!.user.id },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
  });

  app.get('/users/me/exports/:id/download', async (request) => {
    const params = parseOrThrow(z.object({ id: z.string().cuid() }), request.params);
    const job = await prisma.exportJob.findFirst({ where: { id: params.id, userId: request.auth!.user.id } });
    if (!job) throw new AppError(404, 'EXPORT_NOT_FOUND', '导出任务不存在');
    if (job.status !== 'READY' || !job.objectKey || !job.expiresAt || job.expiresAt <= new Date()) {
      throw new AppError(409, 'EXPORT_NOT_READY', '导出文件尚未准备好或已过期');
    }
    return { url: await createSignedObjectUrl(job.objectKey, 600, `balcony-export-${job.id}.zip`), expiresIn: 600 };
  });

  app.delete('/users/me', async (request, reply) => {
    const input = parseOrThrow(z.object({ confirm: z.literal('DELETE'), password: z.string().min(1).max(128) }), request.body);
    if (!(await verifyPassword(request.auth!.user.passwordHash, input.password))) {
      throw new AppError(403, 'INVALID_PASSWORD', '密码错误');
    }
    if (request.auth!.user.status === 'DELETING' && request.auth!.user.deleteAfter) {
      return reply.status(202).send({ deleteAfter: request.auth!.user.deleteAfter, alreadyRequested: true });
    }
    const deleteAfter = new Date(Date.now() + 7 * 86_400_000);
    await prisma.user.update({
      where: { id: request.auth!.user.id },
      data: { status: 'DELETING', deleteRequestedAt: new Date(), deleteAfter },
    });
    return reply.status(202).send({ deleteAfter });
  });

  app.post('/users/me/delete/cancel', async (request) => {
    return prisma.user.update({
      where: { id: request.auth!.user.id },
      data: { status: 'ACTIVE', deleteRequestedAt: null, deleteAfter: null },
      select: { id: true, status: true, deleteAfter: true },
    });
  });
}
