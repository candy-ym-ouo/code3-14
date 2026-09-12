import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from './config.js';

const credentials = {
  accessKeyId: config.S3_ACCESS_KEY,
  secretAccessKey: config.S3_SECRET_KEY,
};

export const storageClient = new S3Client({
  endpoint: config.S3_ENDPOINT,
  region: config.S3_REGION,
  credentials,
  forcePathStyle: config.S3_FORCE_PATH_STYLE,
});

const signingClient = new S3Client({
  endpoint: config.S3_PUBLIC_ENDPOINT,
  region: config.S3_REGION,
  credentials,
  forcePathStyle: config.S3_FORCE_PATH_STYLE,
});

export async function putObject(key: string, body: Buffer, contentType: string) {
  await storageClient.send(
    new PutObjectCommand({
      Bucket: config.S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

export async function getObjectBuffer(key: string): Promise<Buffer> {
  const result = await storageClient.send(
    new GetObjectCommand({ Bucket: config.S3_BUCKET, Key: key }),
  );
  if (!result.Body) throw new Error(`Object ${key} has no body`);
  return Buffer.from(await result.Body.transformToByteArray());
}

export async function removeObject(key: string) {
  await storageClient.send(new DeleteObjectCommand({ Bucket: config.S3_BUCKET, Key: key }));
}

export async function createSignedObjectUrl(
  key: string,
  expiresInSeconds = 600,
  downloadFilename?: string,
) {
  return getSignedUrl(
    signingClient,
    new GetObjectCommand({
      Bucket: config.S3_BUCKET,
      Key: key,
      ResponseContentDisposition: downloadFilename
        ? `attachment; filename*=UTF-8''${encodeURIComponent(downloadFilename)}`
        : undefined,
    }),
    { expiresIn: expiresInSeconds },
  );
}

export function photoObjectKey(workspaceId: string, id: string, extension: string) {
  return `photos/${workspaceId}/${id}/original.${extension}`;
}

export function photoThumbnailKey(workspaceId: string, id: string) {
  return `photos/${workspaceId}/${id}/thumbnail.webp`;
}

export function exportObjectKey(userId: string, exportId: string) {
  return `exports/${userId}/${exportId}.zip`;
}
