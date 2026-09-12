import { describe, expect, it } from 'vitest';
import { booleanQuerySchema, ianaTimezoneSchema, registerSchema, reminderSchema } from './index.js';

describe('shared query schemas', () => {
  it('does not coerce the string "false" to true', () => {
    expect(booleanQuerySchema.parse('false')).toBe(false);
    expect(booleanQuerySchema.parse('0')).toBe(false);
    expect(booleanQuerySchema.parse('true')).toBe(true);
    expect(booleanQuerySchema.parse('1')).toBe(true);
    expect(booleanQuerySchema.parse(undefined)).toBe(false);
  });

  it('accepts IANA timezones and rejects arbitrary strings', () => {
    expect(ianaTimezoneSchema.parse('Asia/Shanghai')).toBe('Asia/Shanghai');
    expect(ianaTimezoneSchema.safeParse('Shanghai Time').success).toBe(false);
  });

  it('normalizes registration email whitespace and case', () => {
    const result = registerSchema.parse({
      email: '  User@Example.COM ',
      password: 'correct-horse-battery',
      displayName: 'User',
      timezone: 'UTC',
    });
    expect(result.email).toBe('user@example.com');
  });
});

describe('reminder schema', () => {
  it('normalizes an empty optional reminder time', () => {
    const result = reminderSchema.parse({
      workspaceId: 'ckx1234567890123456789012',
      title: '周期提醒',
      reminderType: 'WATERING',
      targetType: 'WORKSPACE',
      triggerMode: 'INTERVAL',
      timezone: 'Asia/Shanghai',
      intervalValue: 1,
      intervalUnit: 'DAY',
      timeOfDay: '',
      weekdays: [],
      channels: ['IN_APP'],
      fixedSchedule: false,
      cooldownSeconds: 43200,
    });
    expect(result.timeOfDay).toBeNull();
  });

  it('rejects impossible plant status thresholds', () => {
    const result = reminderSchema.safeParse({
      workspaceId: 'ckx1234567890123456789012',
      title: '状态提醒',
      reminderType: 'OBSERVATION',
      targetType: 'WORKSPACE',
      triggerMode: 'THRESHOLD',
      timezone: 'Asia/Shanghai',
      weekdays: [],
      channels: ['IN_APP'],
      fixedSchedule: false,
      cooldownSeconds: 43200,
      threshold: { metric: 'PLANT_STATUS', operator: 'EQ', value: 'UNKNOWN', consecutive: 1 },
    });
    expect(result.success).toBe(false);
  });
});
