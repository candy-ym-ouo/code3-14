import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { hash, verify } from '@node-rs/argon2';
import { config, isProduction } from '../config.js';
import { prisma } from '../db.js';
import { AppError } from './errors.js';

export const SESSION_COOKIE = 'balcony_session';
export const CSRF_COOKIE = 'balcony_csrf';
export const SESSION_DAYS = 30;

function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export async function hashPassword(password: string) {
  return hash(password, {
    algorithm: 2,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
}

export async function verifyPassword(passwordHash: string, password: string) {
  return verify(passwordHash, password);
}

export async function createSession(userId: string, request: FastifyRequest) {
  const token = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await prisma.session.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      csrfHash: hashToken(csrfToken),
      expiresAt,
      ip: request.ip,
      userAgent: request.headers['user-agent']?.slice(0, 500),
    },
  });
  return { token, csrfToken, expiresAt };
}

export function setAuthCookies(
  reply: FastifyReply,
  session: { token: string; csrfToken: string; expiresAt: Date },
) {
  reply.setCookie(SESSION_COOKIE, session.token, {
    path: '/',
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: 'lax',
    expires: session.expiresAt,
  });
  reply.setCookie(CSRF_COOKIE, session.csrfToken, {
    path: '/',
    httpOnly: false,
    secure: config.COOKIE_SECURE,
    sameSite: 'lax',
    expires: session.expiresAt,
  });
}

export function clearAuthCookies(reply: FastifyReply) {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
  reply.clearCookie(CSRF_COOKIE, { path: '/' });
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export async function authenticateRequest(request: FastifyRequest) {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) return null;
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });
  if (
    !session ||
    session.revokedAt ||
    session.expiresAt <= new Date() ||
    session.user.status === 'DELETED'
  ) {
    return null;
  }

  const method = request.method.toUpperCase();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const csrfCookie = request.cookies[CSRF_COOKIE] ?? '';
    const csrfHeader = request.headers['x-csrf-token'];
    if (
      typeof csrfHeader !== 'string' ||
      !csrfCookie ||
      !safeEqual(hashToken(csrfHeader), session.csrfHash) ||
      !safeEqual(csrfCookie, csrfHeader)
    ) {
      throw new AppError(403, 'CSRF_INVALID', 'CSRF 校验失败，请刷新页面后重试');
    }
  }

  return { session, user: session.user };
}

export async function requireAuth(request: FastifyRequest) {
  const auth = await authenticateRequest(request);
  if (!auth) throw new AppError(401, 'UNAUTHORIZED', '请先登录');
  request.auth = auth;
  const shouldUpdate = Date.now() - auth.session.lastSeenAt.getTime() > 5 * 60 * 1000;
  if (shouldUpdate) {
    await prisma.session.update({
      where: { id: auth.session.id },
      data: { lastSeenAt: new Date() },
    });
  }
}

export async function revokeCurrentSession(request: FastifyRequest) {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) return;
  await prisma.session.updateMany({
    where: { tokenHash: hashToken(token), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export function passwordResetToken() {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

export function hashResetToken(token: string) {
  return hashToken(token);
}

export function cookieSecuritySummary() {
  return { secure: config.COOKIE_SECURE, production: isProduction };
}
