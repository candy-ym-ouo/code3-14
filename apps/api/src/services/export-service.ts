import JSZip from 'jszip';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { exportObjectKey, putObject } from '../storage.js';

function csvEscape(value: unknown) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function toCsv(rows: Record<string, unknown>[]) {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]!);
  return [headers.join(','), ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(','))].join('\n');
}

export async function generateUserExport(userId: string, exportId: string) {
  await prisma.exportJob.update({ where: { id: exportId }, data: { status: 'PROCESSING' } });
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        memberships: {
          include: {
            workspace: {
              include: {
                balconies: { include: { zones: true } },
                plants: true,
                observations: { where: { deletedAt: null }, orderBy: { observedAt: 'asc' } },
                actionLogs: { where: { deletedAt: null }, orderBy: { startedAt: 'asc' } },
                photos: { where: { deletedAt: null } },
                reminders: { include: { occurrences: true } },
              },
            },
          },
        },
        notifications: true,
      },
    });
    if (!user) throw new Error('User not found');

    const observations = user.memberships.flatMap((membership) =>
      membership.workspace.observations.map((item) => ({
        workspace: membership.workspace.name,
        observedAt: item.observedAt.toISOString(),
        zoneId: item.zoneId,
        plantId: item.plantId,
        temperatureC: Number(item.temperatureC),
        lightLevel: item.lightLevel,
        lux: item.lux,
        windDirection: item.windDirection,
        windDegrees: item.windDegrees,
        windSpeedMps: item.windSpeedMps ? Number(item.windSpeedMps) : null,
        plantStatus: item.plantStatus,
        tags: item.plantTags.join('|'),
        notes: item.notes,
      })),
    );
    const actions = user.memberships.flatMap((membership) =>
      membership.workspace.actionLogs.map((item) => ({
        workspace: membership.workspace.name,
        type: item.actionType,
        title: item.title,
        startedAt: item.startedAt.toISOString(),
        completedAt: item.completedAt?.toISOString() ?? null,
        zoneId: item.zoneId,
        plantId: item.plantId,
        parameters: item.parametersJson,
        notes: item.notes,
      })),
    );

    const { passwordHash: _passwordHash, ...safeUser } = user;
    const zip = new JSZip();
    zip.file('account.json', JSON.stringify({ exportedAt: new Date().toISOString(), user: safeUser, observations, actions }, null, 2));
    zip.file('observations.csv', toCsv(observations));
    zip.file('actions.csv', toCsv(actions));
    const archive = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const objectKey = exportObjectKey(userId, exportId);
    await putObject(objectKey, archive, 'application/zip');
    const expiresAt = new Date(Date.now() + config.EXPORT_RETENTION_HOURS * 60 * 60 * 1000);
    await prisma.exportJob.update({
      where: { id: exportId },
      data: { status: 'READY', objectKey, expiresAt, error: null },
    });
    return objectKey;
  } catch (error) {
    await prisma.exportJob.update({
      where: { id: exportId },
      data: { status: 'FAILED', error: error instanceof Error ? error.message.slice(0, 1000) : 'Unknown error' },
    });
    throw error;
  }
}
