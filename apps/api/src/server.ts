import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { HeadBucketCommand } from '@aws-sdk/client-s3';
import { config, isProduction } from './config.js';
import { prisma } from './db.js';
import { redis } from './redis.js';
import { storageClient } from './storage.js';
import { registerErrorHandler } from './lib/errors.js';
import { registerRoutes } from './routes/index.js';
import { jobsQueue } from './queue.js';

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]', 'body.password', 'body.token'],
    },
    trustProxy: isProduction,
    requestIdHeader: 'x-request-id',
  });

  await app.register(cookie, { secret: config.SESSION_SECRET });
  await app.register(cors, {
    origin: config.APP_BASE_URL,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'Idempotency-Key', 'X-Request-Id'],
  });
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(rateLimit, {
    max: isProduction ? 300 : 3000,
    timeWindow: '1 minute',
  });
  await app.register(multipart, {
    limits: {
      fileSize: config.UPLOAD_MAX_BYTES,
      files: 1,
      fields: 20,
    },
  });

  registerErrorHandler(app);
  await app.register(registerRoutes, { prefix: '/api/v1' });

  app.get('/api/v1/health/live', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));
  app.get('/api/v1/health/ready', async (_request, reply) => {
    try {
      await Promise.all([
        prisma.$queryRaw`SELECT 1`,
        redis.ping(),
        storageClient.send(new HeadBucketCommand({ Bucket: config.S3_BUCKET })),
      ]);
      return { status: 'ready', timestamp: new Date().toISOString() };
    } catch (error) {
      reply.status(503);
      return {
        status: 'not_ready',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      };
    }
  });

  return app;
}

async function main() {
  const app = await buildApp();
  await app.listen({ host: '0.0.0.0', port: config.PORT });
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await app.close();
    await jobsQueue.close();
    await redis.quit();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
