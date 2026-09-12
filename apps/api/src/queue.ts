import { Queue } from 'bullmq';
import { redis } from './redis.js';

export const jobsQueue = new Queue('balcony-jobs', {
  connection: redis,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: 500,
    removeOnFail: 2000,
  },
});

export async function enqueueJob(
  name: string,
  data: Record<string, unknown>,
  options: { delayMs?: number; jobId?: string } = {},
) {
  return jobsQueue.add(name, data, {
    delay: options.delayMs && options.delayMs > 0 ? options.delayMs : undefined,
    jobId: options.jobId,
  });
}
