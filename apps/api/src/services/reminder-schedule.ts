import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import type { Reminder } from '@prisma/client';

dayjs.extend(utc);
dayjs.extend(timezone);

export function computeNextRunAt(
  reminder: Pick<
    Reminder,
    'triggerMode' | 'intervalValue' | 'intervalUnit' | 'timeOfDay' | 'weekdays' | 'timezone'
  >,
  from: Date = new Date(),
): Date | null {
  if (reminder.triggerMode === 'ONCE') return null;
  if (reminder.triggerMode === 'THRESHOLD') return null;
  if (!reminder.intervalValue || !reminder.intervalUnit) return null;

  const value = reminder.intervalValue;
  const unit = reminder.intervalUnit;
  let candidate = dayjs(from).tz(reminder.timezone);

  if (unit === 'MINUTE') candidate = candidate.add(value, 'minute');
  if (unit === 'DAY') candidate = candidate.add(value, 'day');
  if (unit === 'WEEK') candidate = candidate.add(value, 'week');
  if (unit === 'MONTH') candidate = candidate.add(value, 'month');

  if (reminder.timeOfDay && ['DAY', 'WEEK', 'MONTH'].includes(unit)) {
    const [hour, minute] = reminder.timeOfDay.split(':').map(Number);
    candidate = candidate.hour(hour ?? 0).minute(minute ?? 0).second(0).millisecond(0);
    if (!candidate.isAfter(dayjs(from).tz(reminder.timezone))) {
      candidate = candidate.add(unit === 'DAY' ? 1 : unit === 'WEEK' ? 1 : 1, unit.toLowerCase() as 'day' | 'week' | 'month');
    }
  }

  if (unit === 'WEEK' && reminder.weekdays.length > 0) {
    const allowed = new Set(reminder.weekdays);
    let attempts = 0;
    while (!allowed.has(candidate.day()) && attempts < 14) {
      candidate = candidate.add(1, 'day');
      attempts += 1;
    }
  }

  return candidate.toDate();
}

export function isValidReminderConfiguration(
  triggerMode: Reminder['triggerMode'],
  intervalValue: number | null | undefined,
  intervalUnit: Reminder['intervalUnit'],
): boolean {
  if (triggerMode === 'INTERVAL') return Boolean(intervalValue && intervalUnit);
  return true;
}

export { dayjs };
