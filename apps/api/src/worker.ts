import { Worker, type Job } from 'bullmq';
import { prisma } from './db.js';
import { redis } from './redis.js';
import { jobsQueue } from './queue.js';
import { sendMail } from './mail.js';
import { removeObject } from './storage.js';
import { generateThumbnail } from './services/photo-service.js';
import { enqueuePendingEmailNotifications, processDueReminders, processSnoozedReminders } from './services/notifications.js';
import { evaluateThresholdReminders } from './services/threshold-reminders.js';
import { generateUserExport } from './services/export-service.js';

async function processEmail(notificationId: string) {
  const staleBefore = new Date(Date.now() - 15 * 60_000);
  const claimed = await prisma.notification.updateMany({
    where: {
      id: notificationId,
      channel: 'EMAIL',
      OR: [
        { status: { in: ['PENDING', 'FAILED'] } },
        { status: 'PROCESSING', updatedAt: { lt: staleBefore } },
      ],
    },
    data: { status: 'PROCESSING' },
  });
  if (claimed.count === 0) return;

  const notification = await prisma.notification.findUnique({
    where: { id: notificationId },
    include: { user: true },
  });
  if (!notification || notification.channel !== 'EMAIL') {
    await prisma.notification.updateMany({
      where: { id: notificationId, status: 'PROCESSING' },
      data: { status: 'FAILED' },
    });
    return;
  }

  try {
    await sendMail(notification.user.email, notification.title, notification.body);
    await prisma.notification.update({
      where: { id: notification.id },
      data: { status: 'SENT', sentAt: new Date() },
    });
  } catch (error) {
    await prisma.notification.update({
      where: { id: notification.id },
      data: { status: 'FAILED' },
    });
    throw error;
  }
}

async function cleanupRetention() {
  const now = new Date();
  const expiredExports = await prisma.exportJob.findMany({
    where: { status: 'READY', expiresAt: { lte: now } },
    take: 100,
  });
  for (const item of expiredExports) {
    if (item.objectKey) await removeObject(item.objectKey);
    await prisma.exportJob.delete({ where: { id: item.id } });
  }

  const oldDeletedPhotos = await prisma.photo.findMany({
    where: { deletedAt: { lte: new Date(now.getTime() - 30 * 86_400_000) } },
    take: 200,
  });
  for (const photo of oldDeletedPhotos) {
    await removeObject(photo.objectKey);
    if (photo.thumbnailKey) await removeObject(photo.thumbnailKey);
    await prisma.photo.delete({ where: { id: photo.id } });
  }

  await prisma.session.deleteMany({ where: { expiresAt: { lte: new Date(now.getTime() - 30 * 86_400_000) } } });
  await prisma.passwordResetToken.deleteMany({ where: { expiresAt: { lte: new Date(now.getTime() - 30 * 86_400_000) } } });
  return { expiredExports: expiredExports.length, deletedPhotos: oldDeletedPhotos.length };
}

async function purgeAccounts() {
  const users = await prisma.user.findMany({
    where: { status: 'DELETING', deleteAfter: { lte: new Date() } },
    take: 20,
    include: { uploadedPhotos: true, exportJobs: true },
  });
  for (const user of users) {
    for (const photo of user.uploadedPhotos) {
      await removeObject(photo.objectKey);
      if (photo.thumbnailKey) await removeObject(photo.thumbnailKey);
    }
    for (const job of user.exportJobs) {
      if (job.objectKey) await removeObject(job.objectKey);
    }
    await prisma.user.delete({ where: { id: user.id } });
  }
  return { purged: users.length };
}

async function handleJob(job: Job) {
  if (job.name === 'reminder.scan') {
    const due = await processDueReminders();
    const snoozed = await processSnoozedReminders();
    return { due, snoozed };
  }
  if (job.name === 'reminder.threshold') {
    return evaluateThresholdReminders(String(job.data.observationId));
  }
  if (job.name === 'photo.thumbnail') {
    return { generated: await generateThumbnail(String(job.data.photoId)) };
  }
  if (job.name === 'notification.email.scan') {
    return { queued: await enqueuePendingEmailNotifications() };
  }
  if (job.name === 'notification.email') {
    await processEmail(String(job.data.notificationId));
    return { sent: true };
  }
  if (job.name === 'export.generate') {
    await generateUserExport(String(job.data.userId), String(job.data.exportId));
    return { generated: true };
  }
  if (job.name === 'retention.cleanup') return cleanupRetention();
  if (job.name === 'account.purge') return purgeAccounts();
  throw new Error(`Unknown job: ${job.name}`);
}

async function main() {
  await jobsQueue.add('reminder.scan', {}, { repeat: { pattern: '* * * * *' }, jobId: 'reminder-scan-minute' });
  await jobsQueue.add('notification.email.scan', {}, { repeat: { pattern: '* * * * *' }, jobId: 'notification-email-scan-minute' });
  await jobsQueue.add('retention.cleanup', {}, { repeat: { pattern: '17 3 * * *' }, jobId: 'retention-cleanup-daily' });
  await jobsQueue.add('account.purge', {}, { repeat: { pattern: '32 4 * * *' }, jobId: 'account-purge-daily' });

  const worker = new Worker('balcony-jobs', handleJob, {
    connection: redis,
    concurrency: 5,
  });
  worker.on('completed', (job) => console.info(`[worker] completed ${job.name} (${job.id})`));
  worker.on('failed', (job, error) => console.error(`[worker] failed ${job?.name} (${job?.id})`, error));

  const shutdown = async () => {
    await worker.close();
    await jobsQueue.close();
    await redis.quit();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  console.info('[worker] started');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
