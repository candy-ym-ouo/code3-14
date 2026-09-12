import type { FastifyInstance } from 'fastify';
import { authRoutes } from './auth.js';
import { balconyRoutes } from './balconies.js';
import { plantRoutes } from './plants.js';
import { observationRoutes } from './observations.js';
import { actionRoutes } from './actions.js';
import { photoRoutes } from './photos.js';
import { analyticsRoutes } from './analytics.js';
import { reminderRoutes } from './reminders.js';
import { notificationRoutes } from './notifications.js';
import { userRoutes } from './users.js';

export async function registerRoutes(app: FastifyInstance) {
  await app.register(authRoutes);
  await app.register(balconyRoutes);
  await app.register(plantRoutes);
  await app.register(observationRoutes);
  await app.register(actionRoutes);
  await app.register(photoRoutes);
  await app.register(analyticsRoutes);
  await app.register(reminderRoutes);
  await app.register(notificationRoutes);
  await app.register(userRoutes);
}
