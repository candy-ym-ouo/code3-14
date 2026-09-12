import { Prisma, type Reminder, type ReminderOccurrence } from '@prisma/client';
import { prisma } from '../db.js';
import { enqueueJob } from '../queue.js';
import { computeNextRunAt } from './reminder-schedule.js';

type ReminderWithUser = Reminder & {
  user: { id: string; email: string; displayName: string };
};

async function insertNotificationOnce(data: {
  userId: string;
  occurrenceId: string;
  channel: 'IN_APP' | 'EMAIL';
  dedupeKey: string;
  title: string;
  body: string;
  status: 'SENT' | 'PENDING';
}) {
  try {
    return await prisma.notification.create({
      data: {
        ...data,
        sentAt: data.status === 'SENT' ? new Date() : null,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return prisma.notification.findUnique({ where: { dedupeKey: data.dedupeKey } });
    }
    throw error;
  }
}

async function sendOccurrenceNotifications(reminder: ReminderWithUser, occurrence: ReminderOccurrence) {
  const body = occurrence.snoozedUntil
    ? `提醒再次到期：${reminder.title}`
    : `提醒到期：${reminder.title}`;

  await insertNotificationOnce({
    userId: reminder.userId,
    occurrenceId: occurrence.id,
    channel: 'IN_APP',
    dedupeKey: `occurrence-${occurrence.id}-v${occurrence.deliveryVersion}-IN_APP`,
    title: reminder.title,
    body,
    status: 'SENT',
  });

  if (!reminder.channelMask.includes('EMAIL')) return;

  const emailNotification = await insertNotificationOnce({
    userId: reminder.userId,
    occurrenceId: occurrence.id,
    channel: 'EMAIL',
    dedupeKey: `occurrence-${occurrence.id}-v${occurrence.deliveryVersion}-EMAIL`,
    title: reminder.title,
    body,
    status: 'PENDING',
  });
  if (emailNotification && ['PENDING', 'FAILED'].includes(emailNotification.status)) {
    await enqueueJob(
      'notification.email',
      { notificationId: emailNotification.id },
      { jobId: `email-${emailNotification.id}` },
    );
  }
}

async function findOrCreateOccurrence(reminder: ReminderWithUser, dueAt: Date) {
  const dedupeKey = `${reminder.id}:${dueAt.toISOString()}`;
  try {
    const occurrence = await prisma.reminderOccurrence.create({
      data: { reminderId: reminder.id, dueAt, dedupeKey },
    });
    return { occurrence, created: true };
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
    const occurrence = await prisma.reminderOccurrence.findUnique({ where: { dedupeKey } });
    if (!occurrence) throw error;
    return { occurrence, created: false };
  }
}

export async function notifyReminder(
  reminder: ReminderWithUser,
  dueAt: Date,
  options: { advanceSchedule?: boolean } = {},
) {
  const active = await prisma.reminder.findUnique({
    where: { id: reminder.id },
    select: { isActive: true },
  });
  if (!active?.isActive) return null;
  const { occurrence, created } = await findOrCreateOccurrence(reminder, dueAt);
  if (['DONE', 'DISMISSED'].includes(occurrence.status)) return null;

  await sendOccurrenceNotifications(reminder, occurrence);
  if (occurrence.status !== 'SENT') {
    await prisma.reminderOccurrence.update({
      where: { id: occurrence.id },
      data: { status: 'SENT', sentAt: occurrence.sentAt ?? new Date() },
    });
  }

  if (options.advanceSchedule !== false) {
    const current = await prisma.reminder.findUnique({ where: { id: reminder.id } });
    if (current?.isActive && current.nextRunAt?.getTime() === dueAt.getTime()) {
      await prisma.reminder.updateMany({
        where: { id: reminder.id, isActive: true, nextRunAt: dueAt },
        data: {
          nextRunAt: computeNextRunAt(current, dueAt),
          isActive: current.triggerMode !== 'ONCE',
        },
      });
    }
  }

  return created ? occurrence : null;
}

export async function processDueReminders(now = new Date(), limit = 200) {
  const reminders = await prisma.reminder.findMany({
    where: {
      isActive: true,
      triggerMode: { not: 'THRESHOLD' },
      nextRunAt: { lte: now },
    },
    include: { user: { select: { id: true, email: true, displayName: true } } },
    orderBy: { nextRunAt: 'asc' },
    take: limit,
  });

  let sent = 0;
  for (const reminder of reminders) {
    const occurrence = await notifyReminder(reminder, reminder.nextRunAt ?? now);
    if (occurrence) sent += 1;
  }
  return { scanned: reminders.length, sent };
}

export async function processSnoozedReminders(now = new Date(), limit = 200) {
  const occurrences = await prisma.reminderOccurrence.findMany({
    where: { status: 'SNOOZED', snoozedUntil: { lte: now }, reminder: { isActive: true } },
    include: {
      reminder: {
        include: { user: { select: { id: true, email: true, displayName: true } } },
      },
    },
    orderBy: { snoozedUntil: 'asc' },
    take: limit,
  });

  let sent = 0;
  for (const occurrence of occurrences) {
    await sendOccurrenceNotifications(occurrence.reminder, occurrence);
    await prisma.reminderOccurrence.updateMany({
      where: { id: occurrence.id, status: 'SNOOZED' },
      data: { status: 'SENT', sentAt: new Date() },
    });
    sent += 1;
  }
  return sent;
}

export async function enqueuePendingEmailNotifications(limit = 200) {
  const staleBefore = new Date(Date.now() - 15 * 60_000);
  const notifications = await prisma.notification.findMany({
    where: {
      channel: 'EMAIL',
      OR: [
        { status: 'PENDING' },
        { status: 'PROCESSING', updatedAt: { lt: staleBefore } },
      ],
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });
  for (const notification of notifications) {
    await enqueueJob(
      'notification.email',
      { notificationId: notification.id },
      { jobId: `email-${notification.id}-${notification.updatedAt.getTime()}` },
    );
  }
  return notifications.length;
}
