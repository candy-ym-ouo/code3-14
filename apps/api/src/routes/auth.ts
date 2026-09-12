import type { FastifyInstance } from 'fastify';
import { ianaTimezoneSchema, loginSchema, registerSchema } from '@balcony/shared';
import { z } from 'zod';
import { prisma } from '../db.js';
import { config } from '../config.js';
import {
  clearAuthCookies,
  createSession,
  hashPassword,
  hashResetToken,
  passwordResetToken,
  requireAuth,
  revokeCurrentSession,
  setAuthCookies,
  verifyPassword,
} from '../lib/auth.js';
import { AppError, parseOrThrow } from '../lib/errors.js';
import { enqueueJob } from '../queue.js';

const forgotSchema = z.object({ email: z.string().trim().email().transform((value) => value.toLowerCase()) });
const resetSchema = z.object({ token: z.string().min(20), password: z.string().min(10).max(128) });

export async function authRoutes(app: FastifyInstance) {
  app.post('/auth/register', async (request, reply) => {
    const input = parseOrThrow(registerSchema, request.body);
    const existing = await prisma.user.findUnique({ where: { email: input.email } });
    if (existing) throw new AppError(409, 'EMAIL_EXISTS', '该邮箱已注册');

    const passwordHash = await hashPassword(input.password);
    const user = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email: input.email,
          passwordHash,
          displayName: input.displayName,
          timezone: input.timezone ?? config.DEFAULT_TIMEZONE,
        },
      });
      await tx.workspace.create({
        data: {
          name: '我的阳台',
          ownerUserId: created.id,
          members: { create: { userId: created.id, role: 'OWNER' } },
        },
      });
      return tx.user.findUniqueOrThrow({
        where: { id: created.id },
        include: { memberships: { include: { workspace: true } } },
      });
    }).catch((error) => {
      if (error?.code === 'P2002') throw new AppError(409, 'EMAIL_EXISTS', '该邮箱已注册');
      throw error;
    });

    const session = await createSession(user.id, request);
    setAuthCookies(reply, session);
    return reply.status(201).send({
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        timezone: user.timezone,
        locale: user.locale,
        status: user.status,
      },
      csrfToken: session.csrfToken,
    });
  });

  app.post('/auth/login', async (request, reply) => {
    const input = parseOrThrow(loginSchema, request.body);
    const user = await prisma.user.findUnique({ where: { email: input.email } });
    if (!user || user.status === 'DELETED' || !(await verifyPassword(user.passwordHash, input.password))) {
      throw new AppError(401, 'INVALID_CREDENTIALS', '邮箱或密码错误');
    }
    const session = await createSession(user.id, request);
    setAuthCookies(reply, session);
    return { user: { id: user.id, email: user.email, displayName: user.displayName, timezone: user.timezone, locale: user.locale, status: user.status }, csrfToken: session.csrfToken };
  });

  app.post('/auth/logout', async (request, reply) => {
    await revokeCurrentSession(request);
    clearAuthCookies(reply);
    return reply.status(204).send();
  });

  app.get('/auth/me', { preHandler: requireAuth }, async (request) => {
    const user = request.auth!.user;
    const memberships = await prisma.workspaceMember.findMany({
      where: { userId: user.id },
      include: { workspace: { include: { _count: { select: { balconies: true, plants: true, observations: true } } } } },
      orderBy: { createdAt: 'asc' },
    });
    return {
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        timezone: user.timezone,
        locale: user.locale,
        status: user.status,
      },
      workspaces: memberships.map((membership) => ({ ...membership.workspace, role: membership.role })),
    };
  });

  app.patch('/users/me', { preHandler: requireAuth }, async (request) => {
    const input = parseOrThrow(
      z.object({
        displayName: z.string().trim().min(1).max(80).optional(),
        timezone: ianaTimezoneSchema.optional(),
        locale: z.string().min(2).max(20).optional(),
      }),
      request.body,
    );
    const user = await prisma.user.update({
      where: { id: request.auth!.user.id },
      data: input,
      select: { id: true, email: true, displayName: true, timezone: true, locale: true },
    });
    return { user };
  });

  app.post('/auth/password/forgot', async (request, reply) => {
    const input = parseOrThrow(forgotSchema, request.body);
    const user = await prisma.user.findUnique({ where: { email: input.email } });
    if (user && user.status === 'ACTIVE') {
      const reset = passwordResetToken();
      await prisma.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: reset.tokenHash,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      });
      const notification = await prisma.notification.create({
        data: {
          userId: user.id,
          channel: 'EMAIL',
          title: '重置阳台微气候记录密码',
          body: `${config.APP_BASE_URL}/reset-password?token=${encodeURIComponent(reset.token)}`,
          status: 'PENDING',
        },
      });
      await enqueueJob('notification.email', { notificationId: notification.id }, { jobId: `email-${notification.id}` });
    }
    return reply.status(202).send({ accepted: true });
  });

  app.post('/auth/password/reset', async (request, reply) => {
    const input = parseOrThrow(resetSchema, request.body);
    const token = await prisma.passwordResetToken.findUnique({
      where: { tokenHash: hashResetToken(input.token) },
      include: { user: true },
    });
    if (!token || token.usedAt || token.expiresAt <= new Date() || token.user.status !== 'ACTIVE') {
      throw new AppError(400, 'RESET_TOKEN_INVALID', '重置链接无效或已过期');
    }
    const passwordHash = await hashPassword(input.password);
    await prisma.$transaction([
      prisma.user.update({ where: { id: token.userId }, data: { passwordHash } }),
      prisma.passwordResetToken.updateMany({
        where: { userId: token.userId, usedAt: null },
        data: { usedAt: new Date() },
      }),
      prisma.session.updateMany({ where: { userId: token.userId, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    clearAuthCookies(reply);
    return { ok: true };
  });
}
