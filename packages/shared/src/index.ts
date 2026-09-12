import { z } from 'zod';

export const LIGHT_LEVELS = ['DARK', 'LOW', 'INDIRECT', 'BRIGHT', 'DIRECT'] as const;
export const WIND_DIRECTIONS = [
  'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
] as const;
export const PLANT_STATUSES = ['HEALTHY', 'WATCH', 'CONCERN', 'CRITICAL'] as const;
export const ACTION_TYPES = ['SHADE', 'WATER', 'REPOT', 'MOVE', 'FERTILIZE', 'PRUNE', 'CUSTOM'] as const;
export const REMINDER_TYPES = ['WATERING', 'REPOTTING', 'OBSERVATION', 'TEMPERATURE', 'LIGHT', 'CUSTOM'] as const;
export const TRIGGER_MODES = ['INTERVAL', 'ONCE', 'THRESHOLD'] as const;
export const INTERVAL_UNITS = ['MINUTE', 'DAY', 'WEEK', 'MONTH'] as const;

export const booleanQuerySchema = z.preprocess((value) => {
  if (value === undefined) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') return true;
    if (normalized === 'false' || normalized === '0') return false;
  }
  return value;
}, z.boolean());

export const ianaTimezoneSchema = z.string().trim().min(1).refine((value) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}, '无效的 IANA 时区');

export const timezoneSchema = ianaTimezoneSchema.default('Asia/Shanghai');

const isoDateTimeSchema = z.string().datetime({ offset: true });

function optionalFormNumber<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((value) => (value === null || value === '' ? undefined : value), schema);
}

export const registerSchema = z.object({
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  password: z.string().min(10).max(128),
  displayName: z.string().trim().min(1).max(80),
  timezone: ianaTimezoneSchema.optional(),
});

export const loginSchema = z.object({
  email: z.string().trim().email().transform((value) => value.toLowerCase()),
  password: z.string().min(1).max(128),
});

export const balconySchema = z.object({
  workspaceId: z.string().cuid(),
  name: z.string().trim().min(1).max(80),
  orientation: z.string().trim().max(40).optional(),
  floor: optionalFormNumber(z.number().int().min(-10).max(200).optional()),
  notes: z.string().trim().max(1000).optional(),
});

export const zoneSchema = z.object({
  balconyId: z.string().cuid(),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).optional(),
  heightCm: optionalFormNumber(z.number().int().min(0).max(1000).optional()),
  azimuthDegrees: optionalFormNumber(z.number().int().min(0).max(359).optional()),
  sunExposure: z.enum(LIGHT_LEVELS).optional(),
  sortOrder: z.number().int().min(0).max(10000).default(0),
});

export const plantSchema = z.object({
  workspaceId: z.string().cuid(),
  zoneId: z.string().cuid(),
  name: z.string().trim().min(1).max(80),
  species: z.string().trim().max(120).optional(),
  variety: z.string().trim().max(120).optional(),
  potSizeCm: optionalFormNumber(z.number().int().min(1).max(500).optional()),
  acquiredAt: isoDateTimeSchema.optional(),
  notes: z.string().trim().max(2000).optional(),
});

export const observationSchema = z.object({
  workspaceId: z.string().cuid(),
  balconyId: z.string().cuid(),
  zoneId: z.string().cuid(),
  plantId: z.string().cuid().optional().nullable(),
  observedAt: isoDateTimeSchema,
  temperatureC: z.number().min(-50).max(70),
  lightLevel: z.enum(LIGHT_LEVELS),
  lux: z.number().int().min(0).max(200000).optional().nullable(),
  windDirection: z.enum(WIND_DIRECTIONS),
  windDegrees: z.number().int().min(0).max(359).optional().nullable(),
  windSpeedMps: z.number().min(0).max(100).optional().nullable(),
  plantStatus: z.enum(PLANT_STATUSES),
  plantTags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  soilMoisturePct: z.number().int().min(0).max(100).optional().nullable(),
  soilMoistureSource: z.enum(['ESTIMATED', 'MEASURED']).optional().nullable(),
  notes: z.string().trim().max(3000).optional().nullable(),
  clientRequestId: z.string().uuid().optional(),
});

export const actionSchema = z.object({
  workspaceId: z.string().cuid(),
  balconyId: z.string().cuid(),
  zoneId: z.string().cuid().optional().nullable(),
  plantId: z.string().cuid().optional().nullable(),
  actionType: z.enum(ACTION_TYPES),
  title: z.string().trim().min(1).max(120),
  startedAt: isoDateTimeSchema,
  completedAt: isoDateTimeSchema.optional().nullable(),
  parameters: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
  notes: z.string().trim().max(3000).optional().nullable(),
  clientRequestId: z.string().uuid().optional(),
});

export const reminderSchema = z.object({
  workspaceId: z.string().cuid(),
  title: z.string().trim().min(1).max(120),
  reminderType: z.enum(REMINDER_TYPES),
  targetType: z.enum(['WORKSPACE', 'BALCONY', 'ZONE', 'PLANT']),
  balconyId: z.string().cuid().optional().nullable(),
  zoneId: z.string().cuid().optional().nullable(),
  plantId: z.string().cuid().optional().nullable(),
  triggerMode: z.enum(TRIGGER_MODES),
  runAt: isoDateTimeSchema.optional().nullable(),
  timezone: timezoneSchema,
  intervalValue: z.number().int().min(1).max(3650).optional().nullable(),
  intervalUnit: z.enum(INTERVAL_UNITS).optional().nullable(),
  timeOfDay: z.preprocess((value) => (value === '' ? null : value), z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional().nullable()),
  weekdays: z.array(z.number().int().min(0).max(6)).max(7).default([]),
  threshold: z.object({
    metric: z.enum(['TEMPERATURE', 'PLANT_STATUS']),
    operator: z.enum(['GT', 'GTE', 'LT', 'LTE', 'EQ']),
    value: z.union([z.number(), z.string()]),
    consecutive: z.number().int().min(1).max(10).default(1),
  }).optional().nullable(),
  channels: z.array(z.enum(['IN_APP', 'EMAIL'])).min(1).default(['IN_APP']),
  fixedSchedule: z.boolean().default(false),
  cooldownSeconds: z.number().int().min(60).max(2592000).default(43200),
}).superRefine((value, context) => {
  if (value.threshold?.metric === 'PLANT_STATUS') {
    if (typeof value.threshold.value !== 'string' || !PLANT_STATUSES.includes(value.threshold.value as typeof PLANT_STATUSES[number])) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['threshold', 'value'],
        message: '植物状态阈值必须是 HEALTHY、WATCH、CONCERN 或 CRITICAL',
      });
    }
  }
  if (value.threshold?.metric === 'TEMPERATURE' && typeof value.threshold.value !== 'number') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['threshold', 'value'],
      message: '温度阈值必须是数字',
    });
  }
});

export const paginationSchema = z.object({
  cursor: z.string().cuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ObservationInput = z.infer<typeof observationSchema>;
export type ActionInput = z.infer<typeof actionSchema>;
export type ReminderInput = z.infer<typeof reminderSchema>;
