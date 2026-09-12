import { describe, expect, it } from 'vitest';
import { computeNextRunAt, isValidReminderConfiguration } from './reminder-schedule.js';

describe('computeNextRunAt', () => {
  it('adds a minute interval in UTC', () => {
    const from = new Date('2026-09-12T10:00:00.000Z');
    const next = computeNextRunAt({
      triggerMode: 'INTERVAL',
      intervalValue: 15,
      intervalUnit: 'MINUTE',
      timeOfDay: null,
      weekdays: [],
      timezone: 'UTC',
    }, from);
    expect(next?.toISOString()).toBe('2026-09-12T10:15:00.000Z');
  });

  it('keeps daily reminder at local time across timezone', () => {
    const from = new Date('2026-09-12T00:00:00.000Z');
    const next = computeNextRunAt({
      triggerMode: 'INTERVAL',
      intervalValue: 1,
      intervalUnit: 'DAY',
      timeOfDay: '08:00',
      weekdays: [],
      timezone: 'Asia/Shanghai',
    }, from);
    expect(next?.toISOString()).toBe('2026-09-13T00:00:00.000Z');
  });

  it('returns null for single and threshold reminders', () => {
    expect(computeNextRunAt({
      triggerMode: 'ONCE', intervalValue: null, intervalUnit: null, timeOfDay: null, weekdays: [], timezone: 'UTC',
    })).toBeNull();
    expect(computeNextRunAt({
      triggerMode: 'THRESHOLD', intervalValue: null, intervalUnit: null, timeOfDay: null, weekdays: [], timezone: 'UTC',
    })).toBeNull();
  });
});

describe('isValidReminderConfiguration', () => {
  it('requires interval values for interval reminders', () => {
    expect(isValidReminderConfiguration('INTERVAL', null, null)).toBe(false);
    expect(isValidReminderConfiguration('INTERVAL', 1, 'DAY')).toBe(true);
    expect(isValidReminderConfiguration('ONCE', null, null)).toBe(true);
  });
});
