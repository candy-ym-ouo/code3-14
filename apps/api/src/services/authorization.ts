import type { WorkspaceRole } from '@prisma/client';
import { prisma } from '../db.js';
import { AppError } from '../lib/errors.js';

const roleRank: Record<WorkspaceRole, number> = {
  VIEWER: 0,
  EDITOR: 1,
  OWNER: 2,
};

export async function requireWorkspaceRole(
  userId: string,
  workspaceId: string,
  minimumRole: WorkspaceRole = 'VIEWER',
) {
  const membership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
  });
  if (!membership || roleRank[membership.role] < roleRank[minimumRole]) {
    throw new AppError(403, 'WORKSPACE_FORBIDDEN', '无权访问该空间');
  }
  return membership;
}

export async function workspaceIdForBalcony(balconyId: string, userId: string, minimumRole: WorkspaceRole = 'VIEWER') {
  const balcony = await prisma.balcony.findUnique({ where: { id: balconyId } });
  if (!balcony) throw new AppError(404, 'BALCONY_NOT_FOUND', '阳台不存在');
  await requireWorkspaceRole(userId, balcony.workspaceId, minimumRole);
  return balcony.workspaceId;
}

export async function workspaceIdForZone(zoneId: string, userId: string, minimumRole: WorkspaceRole = 'VIEWER') {
  const zone = await prisma.zone.findUnique({
    where: { id: zoneId },
    include: { balcony: true },
  });
  if (!zone) throw new AppError(404, 'ZONE_NOT_FOUND', '位置不存在');
  await requireWorkspaceRole(userId, zone.balcony.workspaceId, minimumRole);
  return zone.balcony.workspaceId;
}

export async function workspaceIdForPlant(plantId: string, userId: string, minimumRole: WorkspaceRole = 'VIEWER') {
  const plant = await prisma.plant.findUnique({ where: { id: plantId } });
  if (!plant) throw new AppError(404, 'PLANT_NOT_FOUND', '植物不存在');
  await requireWorkspaceRole(userId, plant.workspaceId, minimumRole);
  return plant.workspaceId;
}
