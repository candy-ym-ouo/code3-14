import type { FastifyInstance, FastifyReply } from 'fastify';
import { ZodError } from 'zod';

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public fieldErrors?: Record<string, string[]>,
  ) {
    super(message);
  }
}

export function assertFound<T>(value: T | null | undefined, message = '资源不存在'): T {
  if (value === null || value === undefined) throw new AppError(404, 'NOT_FOUND', message);
  return value;
}

export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((error, request, reply: FastifyReply) => {
    const requestId = request.id;
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        code: error.code,
        message: error.message,
        fieldErrors: error.fieldErrors,
        requestId,
      });
    }
    if (error instanceof ZodError) {
      return reply.status(422).send({
        code: 'VALIDATION_ERROR',
        message: '请求参数不合法',
        fieldErrors: error.flatten().fieldErrors,
        requestId,
      });
    }
    const statusCode =
      error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number'
        ? error.statusCode
        : 500;
    const errorMessage = error instanceof Error ? error.message : '请求处理失败';
    if (statusCode >= 500) request.log.error({ err: error }, 'Unhandled request error');
    return reply.status(statusCode).send({
      code: statusCode >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR',
      message: statusCode >= 500 ? '服务器处理请求失败' : errorMessage,
      requestId,
    });
  });
}

export function parseOrThrow<T>(
  schema: { parse: (value: unknown) => T },
  value: unknown,
): T {
  return schema.parse(value);
}
