import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../db.js';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

export async function resolvePlantZoneAtTime(
  plantId: string,
  at: Date,
  client: DatabaseClient = prisma,
) {
  const plant = await client.plant.findUnique({
    where: { id: plantId },
    select: { zoneId: true },
  });
  if (!plant) return null;

  const [previousMove, nextMove] = await Promise.all([
    client.plantZoneHistory.findFirst({
      where: { plantId, movedAt: { lte: at } },
      orderBy: { movedAt: 'desc' },
      select: { toZoneId: true },
    }),
    client.plantZoneHistory.findFirst({
      where: { plantId, movedAt: { gt: at } },
      orderBy: { movedAt: 'asc' },
      select: { fromZoneId: true },
    }),
  ]);

  return previousMove?.toZoneId ?? nextMove?.fromZoneId ?? plant.zoneId;
}
