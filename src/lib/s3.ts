import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env';

const s3 = new S3Client({
  region: env.s3.region,
  credentials: {
    accessKeyId: env.s3.accessKeyId,
    secretAccessKey: env.s3.secretAccessKey,
  },
  ...(env.s3.endpoint && {
    endpoint: env.s3.endpoint,
    forcePathStyle: true,
  }),
});

export async function uploadRecording(
  key: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: env.s3.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

export async function getPresignedUrl(
  key: string,
  expiresIn = 3600,
): Promise<string> {
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: env.s3.bucket, Key: key }),
    { expiresIn },
  );
}

export async function deleteRecording(key: string): Promise<void> {
  await s3.send(
    new DeleteObjectCommand({ Bucket: env.s3.bucket, Key: key }),
  );
}

// Returns the object body as a Uint8Array along with the content type, so
// routes can proxy bytes to the browser with their own CORS headers instead
// of redirecting to an S3 presigned URL (which lacks Access-Control-Allow-Origin).
export async function getObjectBytes(key: string): Promise<{
  bytes: Uint8Array;
  contentType: string | undefined;
}> {
  const res = await s3.send(
    new GetObjectCommand({ Bucket: env.s3.bucket, Key: key }),
  );
  if (!res.Body) {
    throw Object.assign(new Error('Object not found'), { status: 404 });
  }
  const bytes = await res.Body.transformToByteArray();
  return { bytes, contentType: res.ContentType };
}
