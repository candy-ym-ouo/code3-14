import 'dotenv/config';
import { z } from 'zod';
import { ianaTimezoneSchema } from '@balcony/shared';

const booleanString = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((value) => (value === undefined ? defaultValue : value.toLowerCase() === 'true'));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  APP_BASE_URL: z.string().url().default('http://localhost:5173'),
  API_BASE_URL: z.string().url().default('http://localhost:3000'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  SESSION_SECRET: z.string().min(32).default('development-only-session-secret-change-me'),
  COOKIE_SECURE: booleanString(false),
  DEFAULT_TIMEZONE: ianaTimezoneSchema.default('Asia/Shanghai'),
  S3_ENDPOINT: z.string().url().default('http://localhost:9000'),
  S3_PUBLIC_ENDPOINT: z.string().url().default('http://localhost:9000'),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_BUCKET: z.string().min(1).default('balcony-photos'),
  S3_ACCESS_KEY: z.string().min(1).default('minioadmin'),
  S3_SECRET_KEY: z.string().min(1).default('minioadmin'),
  S3_FORCE_PATH_STYLE: booleanString(true),
  UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(15 * 1024 * 1024),
  EXPORT_RETENTION_HOURS: z.coerce.number().int().positive().default(24),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_SECURE: booleanString(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  MAIL_FROM: z.string().default('Balcony <no-reply@example.com>'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export const config = envSchema.parse(process.env);
export const isProduction = config.NODE_ENV === 'production';
