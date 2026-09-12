import type { FastifyInstance } from 'fastify';
import { booleanQuerySchema, ianaTimezoneSchema, reminderSchema } from '@balcony/shared';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { requireAuth } from '../lib/auth.js';
import { AppError, parseOrThrow } from '../lib/errors.js';
import { requireWorkspaceRole } from '../services/authorization.js';
import { computeNextRunAt, isValidReminderConfiguration } from '../services/reminder-schedule.js';

async function validateReminderTarget(input: {
  workspaceId: string;
  targetType: string;
  balconyId?: string | null;
  zoneId?: string | null;
  plantId?: string | null;
}) {
  if (input.targetType === 'WORKSPACE') return;
  if (input.targetType === 'BALCONY') {
    const balcony = input.balconyId
      ? await prisma.balcony.findFirst({ where: { id: input.balconyId, workspaceId: input.workspaceId, archivedAt: null } })
      : null;
    if (!balcony) throw new AppError(422, 'BALCONY_REQUIRED', '请选择有效阳台');
  }
  if (input.targetType === 'ZONE') {
    const zone = input.zoneId
      ? await prisma.zone.findFirst({ where: { id: input.zoneId, archivedAt: null }, include: { balcony: true } })
      : null;
    if (!zone || zone.balcony.workspaceId !== input.workspaceId) throw new AppError(422, 'ZONE_REQUIRED', '请选择有效位置');
  }
  if (input.targetType === 'PLANT') {
    const plant = input.plantId
      ? await prisma.plant.findFirst({ where: { id: input.plantId, workspaceId: input.workspaceId, archivedAt: null } })
      : null;
    if (!plant) throw new AppError(422, 'PLANT_REQUIRED', '请选择有效植物');
  }
}

export async function reminderRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/reminders', async (request) => {
    const query = parseOrThrow(z.object({ workspaceId: z.string().cuid(), includeInactive: booleanQuerySchema }), request.query);
    await requireWorkspaceRole(request.auth!.user.id, query.workspaceId, 'VIEWER');
    return prisma.reminder.findMany({
      where: { workspaceId: query.workspaceId, userId: request.auth!.user.id, ...(query.includeInactive ? {} : { isActive: true }) },
      include: { plant: true, zone: true, balcony: true, _count: { select: { occurrences: true } } },
      orderBy: [{ isActive: 'desc' }, { nextRunAt: 'asc' }],
    });
  });

  app.post('/reminders', async (request, reply) => {
    const input = parseOrThrow(reminderSchema, request.body);
    await requireWorkspaceRole(request.auth!.user.id, input.workspaceId, 'EDITOR');
    const target = input.targetType === 'WORKSPACE'
      ? { balconyId: null, zoneId: null, plantId: null }
      : input.targetType === 'BALCONY'
        ? { balconyId: input.balconyId ?? null, zoneId: null, plantId: null }
        : input.targetType === 'ZONE'
          ? { balconyId: null, zoneId: input.zoneId ?? null, plantId: null }
          : { balconyId: null, zoneId: null, plantId: input.plantId ?? null };
    await validateReminderTarget({ ...input, ...target });
    if (!isValidReminderConfiguration(input.triggerMode, input.intervalValue, input.intervalUnit ?? null)) {
      throw new AppError(422, 'INVALID_REMINDER_CONFIGURATION', '周期提醒必须设置间隔和单位');
    }
    if (input.triggerMode === 'INTERVAL' && input.intervalUnit === 'MINUTE' && input.timeOfDay) {
      throw new AppError(422, 'INVALID_REMINDER_CONFIGURATION', '分钟级提醒不能设置固定时刻');
    }
    if (input.triggerMode === 'INTERVAL' && input.weekdays.length > 0 && input.intervalUnit !== 'WEEK') {
      throw new AppError(422, 'INVALID_REMINDER_CONFIGURATION', '只有周级提醒可以设置星期');
    }
    if (input.triggerMode === 'THRESHOLD' && !input.threshold) {
      throw new AppError(422, 'THRESHOLD_REQUIRED', '阈值提醒必须设置触发条件');
    }
    if (input.triggerMode === 'ONCE' && !input.runAt) {
      throw new AppError(422, 'RUN_AT_REQUIRED', '单次提醒必须设置执行时间');
    }
    const nextRunAt =
      input.triggerMode === 'ONCE'
        ? new Date(input.runAt!)
        : input.triggerMode === 'INTERVAL'
          ? computeNextRunAt({
              triggerMode: input.triggerMode,
              intervalValue: input.intervalValue ?? null,
              intervalUnit: input.intervalUnit ?? null,
              timeOfDay: input.timeOfDay ?? null,
              weekdays: input.weekdays,
              timezone: input.timezone,
            })
          : null;
    if (input.triggerMode === 'ONCE' && nextRunAt && nextRunAt <= new Date()) {
      throw new AppError(422, 'RUN_AT_IN_PAST', '单次提醒时间必须晚于当前时间');
    }
    const reminder = await prisma.reminder.create({
      data: {
        workspaceId: input.workspaceId,
        userId: request.auth!.user.id,
        title: input.title,
        reminderType: input.reminderType,
        targetType: input.targetType,
        balconyId: target.balconyId,
        zoneId: target.zoneId,
        plantId: target.plantId,
        triggerMode: input.triggerMode,
        timezone: input.timezone,
        intervalValue: input.intervalValue ?? null,
        intervalUnit: input.intervalUnit ?? null,
        timeOfDay: input.timeOfDay ?? null,
        weekdays: input.weekdays,
        thresholdJson: input.threshold ? (input.threshold as Prisma.InputJsonValue) : undefined,
        channelMask: input.channels,
        nextRunAt,
        cooldownSeconds: input.cooldownSeconds,
        fixedSchedule: input.fixedSchedule,
      },
    });
    return reply.status(201).send(reminder);
  });

  app.patch('/reminders/:id', async (request) => {
    const params = parseOrThrow(z.object({ id: z.string().cuid() }), request.params);
    const reminder = await prisma.reminder.findUnique({ where: { id: params.id } });
    if (!reminder) throw new AppError(404, 'REMINDER_NOT_FOUND', '提醒不存在');
    await requireWorkspaceRole(request.auth!.user.id, reminder.workspaceId, 'EDITOR');
    if (reminder.userId !== request.auth!.user.id) throw new AppError(403, 'REMINDER_FORBIDDEN', '只能修改自己的提醒');
    const input = parseOrThrow(
      z.object({
        title: z.string().trim().min(1).max(120).optional(),
        runAt: z.string().datetime({ offset: true }).nullable().optional(),
        timezone: ianaTimezoneSchema.optional(),
        intervalValue: z.number().int().min(1).max(3650).nullable().optional(),
        intervalUnit: z.enum(['MINUTE', 'DAY', 'WEEK', 'MONTH']).nullable().optional(),
        timeOfDay: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional(),
        weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
        channels: z.array(z.enum(['IN_APP', 'EMAIL'])).min(1).optional(),
        cooldownSeconds: z.number().int().min(60).max(2592000).optional(),
        fixedSchedule: z.boolean().optional(),
        isActive: z.boolean().optional(),
      }),
      request.body,
    );
    const intervalUnit = input.intervalUnit === undefined ? reminder.intervalUnit : input.intervalUnit;
    const timeOfDay = input.timeOfDay === undefined ? reminder.timeOfDay : input.timeOfDay;
    const weekdays = input.weekdays === undefined ? reminder.weekdays : input.weekdays;
    if (intervalUnit === 'MINUTE' && timeOfDay) {
      throw new AppError(422, 'INVALID_REMINDER_CONFIGURATION', '分钟级提醒不能设置固定时刻');
    }
    if (weekdays.length > 0 && intervalUnit !== 'WEEK') {
      throw new AppError(422, 'INVALID_REMINDER_CONFIGURATION', '只有周级提醒可以设置星期');
    }
    const shouldComputeInterval =
      reminder.triggerMode === 'INTERVAL' &&
      input.isActive !== false &&
      (input.isActive === true ||
        input.intervalValue !== undefined ||
        input.intervalUnit !== undefined ||
        input.timeOfDay !== undefined ||
        input.weekdays !== undefined ||
        input.timezone !== undefined);
    let nextRunAt: Date | null | undefined;
    if (input.isActive === false) {
      nextRunAt = null;
    } else if (shouldComputeInterval) {
      nextRunAt = computeNextRunAt({ ...reminder, ...input });
      if (!nextRunAt) {
        throw new AppError(422, 'INVALID_REMINDER_CONFIGURATION', '周期提醒必须设置有效的间隔和单位');
      }
    } else if (reminder.triggerMode === 'ONCE' && (input.isActive === true || input.runAt !== undefined)) {
      nextRunAt = input.runAt ? new Date(input.runAt) : reminder.nextRunAt;
      if (!nextRunAt || nextRunAt <= new Date()) {
        throw new AppError(422, 'RUN_AT_REQUIRED', '请设置一个未来的单次提醒时间');
      }
    }
    const { runAt: _runAt, ...updateData } = input;
    return prisma.$transaction(async (tx) => {
      const updated = await tx.reminder.update({
        where: { id: params.id },
        data: { ...updateData, nextRunAt },
      });
      if (input.isActive === false) {
        await tx.reminderOccurrence.updateMany({
          where: { reminderId: params.id, status: { in: ['PENDING', 'SNOOZED'] } },
          data: { status: 'DISMISSED', handledAt: new Date() },
        });
      }
      return updated;
    });
  });

  app.delete('/reminders/:id', async (request, reply) => {
    const params = parseOrThrow(z.object({ id: z.string().cuid() }), request.params);
    const reminder = await prisma.reminder.findUnique({ where: { id: params.id } });
    if (!reminder) throw new AppError(404, 'REMINDER_NOT_FOUND', '提醒不存在');
    await requireWorkspaceRole(request.auth!.user.id, reminder.workspaceId, 'EDITOR');
    if (reminder.userId !== request.auth!.user.id) throw new AppError(403, 'REMINDER_FORBIDDEN', '只能停用自己的提醒');
    await prisma.$transaction([
      prisma.reminder.update({ where: { id: params.id }, data: { isActive: false, nextRunAt: null } }),
      prisma.reminderOccurrence.updateMany({
        where: { reminderId: params.id, status: { in: ['PENDING', 'SNOOZED'] } },
        data: { status: 'DISMISSED', handledAt: new Date() },
      }),
    ]);
    return reply.status(204).send();
  });

  app.get('/reminder-occurrences', async (request) => {
    const query = parseOrThrow(
      z.object({
        workspaceId: z.string().cuid(),
        status: z.enum(['PENDING', 'SENT', 'SNOOZED', 'DONE', 'DISMISSED', 'FAILED']).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      }),
      request.query,
    );
    await requireWorkspaceRole(request.auth!.user.id, query.workspaceId, 'VIEWER');
    return prisma.reminderOccurrence.findMany({
      where: { reminder: { workspaceId: query.workspaceId, userId: request.auth!.user.id }, status: query.status },
      include: { reminder: true },
      orderBy: [{ dueAt: 'desc' }],
      take: query.limit,
    });
  });

  app.post('/reminder-occurrences/:id/complete', async (request) => {
    const params = parseOrThrow(z.object({ id: z.string().cuid() }), request.params);
    const input = parseOrThrow(
      z.object({
        createAction: z.object({
          actionType: z.enum(['SHADE', 'WATER', 'REPOT', 'FERTILIZE', 'PRUNE', 'CUSTOM']),
          title: z.string().trim().min(1).max(120),
          parameters: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
          notes: z.string().trim().max(3000).optional().nullable(),
        }).optional(),
      }).default({}),
      request.body ?? {},
    );
    const occurrence = await prisma.reminderOccurrence.findUnique({
      where: { id: params.id },
      include: { reminder: true },
    });
    if (!occurrence) throw new AppError(404, 'OCCURRENCE_NOT_FOUND', '提醒事件不存在');
    await requireWorkspaceRole(request.auth!.user.id, occurrence.reminder.workspaceId, 'EDITOR');
    if (occurrence.reminder.userId !== request.auth!.user.id) {
      throw new AppError(403, 'REMINDER_FORBIDDEN', '只能处理自己的提醒');
    }
    if (occurrence.status === 'DONE') {
      return { ok: true, actionId: null, nextRunAt: occurrence.reminder.nextRunAt, alreadyHandled: true };
    }
    if (!['PENDING', 'SENT', 'SNOOZED'].includes(occurrence.status)) {
      throw new AppError(409, 'OCCURRENCE_NOT_ACTIONABLE', '该提醒事件当前不能完成');
    }

    const handledAt = new Date();
    const reminder = occurrence.reminder;
    return prisma.$transaction(async (tx) => {
      let actionId: string | null = null;
      if (input.createAction) {
        let balconyId: string | null = reminder.balconyId;
        let zoneId: string | null = reminder.zoneId;
        if (reminder.plantId) {
          const plant = await tx.plant.findUnique({
            where: { id: reminder.plantId },
            select: { id: true, zoneId: true },
          });
          if (!plant) throw new AppError(422, 'PLANT_REQUIRED', '提醒关联的植物不存在');
          if (!zoneId) zoneId = plant.zoneId;
          if (!balconyId) {
            const zone = await tx.zone.findUnique({ where: { id: zoneId }, select: { balconyId: true } });
            balconyId = zone?.balconyId ?? null;
          }
        } else if (zoneId) {
          const zone = await tx.zone.findUnique({ where: { id: zoneId }, select: { balconyId: true } });
          balconyId = zone?.balconyId ?? balconyId;
        }
        if (!balconyId) {
          throw new AppError(422, 'ACTION_SCOPE_REQUIRED', '该提醒没有可关联的阳台或植物');
        }
        const action = await tx.actionLog.create({
          data: {
            workspaceId: reminder.workspaceId,
            balconyId,
            zoneId,
            plantId: reminder.plantId,
            actionType: input.createAction.actionType,
            title: input.createAction.title,
            startedAt: handledAt,
            completedAt: handledAt,
            parametersJson: input.createAction.parameters as Prisma.InputJsonValue,
            notes: input.createAction.notes ?? null,
            createdBy: request.auth!.user.id,
          },
        });
        actionId = action.id;
      }

      const nextRunAt =
        reminder.triggerMode === 'INTERVAL' && !reminder.fixedSchedule
          ? computeNextRunAt(reminder, handledAt)
          : reminder.nextRunAt;
      const updated = await tx.reminderOccurrence.updateMany({
        where: { id: occurrence.id, status: { in: ['PENDING', 'SENT', 'SNOOZED'] } },
        data: { status: 'DONE', handledAt },
      });
      if (updated.count === 0) {
        throw new AppError(409, 'OCCURRENCE_ALREADY_HANDLED', '提醒事件已被处理');
      }
      await tx.reminder.update({ where: { id: reminder.id }, data: { nextRunAt } });
      return { ok: true, actionId, nextRunAt };
    });
  });

  app.post('/reminder-occurrences/:id/snooze', async (request) => {
    const params = parseOrThrow(z.object({ id: z.string().cuid() }), request.params);
    const input = parseOrThrow(z.object({ minutes: z.number().int().min(1).max(1440).optional() }).default({}), request.body ?? {});
    const occurrence = await prisma.reminderOccurrence.findUnique({ where: { id: params.id }, include: { reminder: true } });
    if (!occurrence) throw new AppError(404, 'OCCURRENCE_NOT_FOUND', '提醒事件不存在');
    await requireWorkspaceRole(request.auth!.user.id, occurrence.reminder.workspaceId, 'EDITOR');
    if (occurrence.reminder.userId !== request.auth!.user.id) throw new AppError(403, 'REMINDER_FORBIDDEN', '只能处理自己的提醒');
    if (!['PENDING', 'SENT', 'SNOOZED'].includes(occurrence.status)) {
      throw new AppError(409, 'OCCURRENCE_NOT_ACTIONABLE', '该提醒事件当前不能稍后提醒');
    }
    const snoozedUntil = new Date(Date.now() + (input.minutes ?? occurrence.reminder.snoozeMinutes) * 60_000);
    const updated = await prisma.reminderOccurrence.updateMany({
      where: { id: params.id, status: { in: ['PENDING', 'SENT', 'SNOOZED'] } },
      data: { status: 'SNOOZED', snoozedUntil, deliveryVersion: { increment: 1 } },
    });
    if (updated.count === 0) throw new AppError(409, 'OCCURRENCE_ALREADY_HANDLED', '提醒事件已被处理');
    return { ok: true, snoozedUntil };
  });

  app.post('/reminder-occurrences/:id/dismiss', async (request) => {
    const params = parseOrThrow(z.object({ id: z.string().cuid() }), request.params);
    const occurrence = await prisma.reminderOccurrence.findUnique({ where: { id: params.id }, include: { reminder: true } });
    if (!occurrence) throw new AppError(404, 'OCCURRENCE_NOT_FOUND', '提醒事件不存在');
    await requireWorkspaceRole(request.auth!.user.id, occurrence.reminder.workspaceId, 'EDITOR');
    if (occurrence.reminder.userId !== request.auth!.user.id) throw new AppError(403, 'REMINDER_FORBIDDEN', '只能处理自己的提醒');
    if (occurrence.status === 'DISMISSED') return { ok: true, alreadyHandled: true };
    if (!['PENDING', 'SENT', 'SNOOZED'].includes(occurrence.status)) {
      throw new AppError(409, 'OCCURRENCE_NOT_ACTIONABLE', '该提醒事件当前不能跳过');
    }
    await prisma.$transaction(async (tx) => {
      const updated = await tx.reminderOccurrence.updateMany({
        where: { id: params.id, status: { in: ['PENDING', 'SENT', 'SNOOZED'] } },
        data: { status: 'DISMISSED', handledAt: new Date() },
      });
      if (updated.count === 0) throw new AppError(409, 'OCCURRENCE_ALREADY_HANDLED', '提醒事件已被处理');
      if (occurrence.reminder.triggerMode === 'ONCE') {
        await tx.reminder.update({ where: { id: occurrence.reminder.id }, data: { isActive: false, nextRunAt: null } });
      }
    });
    return { ok: true };
  });
}
