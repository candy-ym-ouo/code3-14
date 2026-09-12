import { createHash, randomUUID } from 'node:crypto';
import sharp, { type Metadata } from 'sharp';
import type { Photo } from '@prisma/client';
import { prisma } from '../db.js';
import { getObjectBuffer, photoObjectKey, photoThumbnailKey, putObject, removeObject } from '../storage.js';
import { AppError } from '../lib/errors.js';
import { enqueueJob } from '../queue.js';

const allowedFormats = new Set(['jpeg', 'png', 'webp', 'heif', 'avif']);
export async function storePhoto(input: {
  workspaceId: string;
  uploadedBy: string;
  buffer: Buffer;
  originalFilename: string;
  observationId?: string | null;
  actionLogId?: string | null;
  plantId?: string | null;
  zoneId?: string | null;
  capturedAt?: Date | null;
}) {
  let metadata: Metadata;
  try {
    metadata = await sharp(input.buffer, { failOn: 'error', animated: false }).metadata();
  } catch {
    throw new AppError(422, 'INVALID_IMAGE', '文件不是受支持的图片');
  }
  if (!metadata.format || !allowedFormats.has(metadata.format) || !metadata.width || !metadata.height) {
    throw new AppError(422, 'INVALID_IMAGE_TYPE', '仅支持 JPEG、PNG、WebP、HEIC、AVIF');
  }
  const pages = metadata.pages ?? 1;
  const pageHeight = metadata.pageHeight ?? metadata.height;
  if (metadata.width * pageHeight * pages > 40_000_000) {
    throw new AppError(413, 'IMAGE_TOO_LARGE', '图片像素尺寸过大');
  }

  let sanitized: { data: Buffer; info: { width: number; height: number } };
  try {
    sanitized = await sharp(input.buffer, { failOn: 'error', animated: false })
      .rotate()
      .webp({ quality: 92, effort: 4 })
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw new AppError(422, 'IMAGE_CONVERSION_FAILED', '图片无法安全转换，请更换文件后重试');
  }
  const sha256 = createHash('sha256').update(sanitized.data).digest('hex');
  const id = randomUUID();
  const objectKey = photoObjectKey(input.workspaceId, id, 'webp');
  await putObject(objectKey, sanitized.data, 'image/webp');

  let photo: Photo;
  try {
    photo = await prisma.photo.create({
      data: {
        id,
        workspaceId: input.workspaceId,
        observationId: input.observationId,
        actionLogId: input.actionLogId,
        plantId: input.plantId,
        zoneId: input.zoneId,
        objectKey,
        originalFilename: input.originalFilename.slice(0, 255),
        mimeType: 'image/webp',
        sizeBytes: sanitized.data.length,
        width: sanitized.info.width,
        height: sanitized.info.height,
        sha256,
        capturedAt: input.capturedAt,
        uploadedBy: input.uploadedBy,
      },
    });
    await enqueueJob(
      'photo.thumbnail',
      { photoId: photo.id },
      { jobId: `photo-thumbnail-${photo.id}` },
    );
  } catch (error) {
    await prisma.photo.deleteMany({ where: { id } }).catch(() => undefined);
    await removeObject(objectKey).catch(() => undefined);
    throw error;
  }
  return photo;
}

export async function generateThumbnail(photoId: string) {
  const photo = await prisma.photo.findFirst({ where: { id: photoId, deletedAt: null } });
  if (!photo) return false;
  const original = await getObjectBuffer(photo.objectKey);
  const thumbnail = await sharp(original)
    .rotate()
    .resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer();
  const thumbnailKey = photoThumbnailKey(photo.workspaceId, photo.id);
  await putObject(thumbnailKey, thumbnail, 'image/webp');
  const updated = await prisma.photo.updateMany({
    where: { id: photo.id, deletedAt: null },
    data: { thumbnailKey },
  });
  if (updated.count === 0) {
    await removeObject(thumbnailKey).catch(() => undefined);
    return false;
  }
  return true;
}
