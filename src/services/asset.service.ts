import { uploadRecording, getObjectBytes } from '../lib/s3';

const ALLOWED_IMAGE_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);
const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

const MAX_BANNER_BYTES = 5 * 1024 * 1024; // 5 MB

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
};

// Uploads a banner image to S3 under `banners/<uuid>.<ext>` and returns the
// object key so the caller can build the public asset URL.
export async function uploadBannerImage(file: File) {
  if (!ALLOWED_IMAGE_MIME.has(file.type)) {
    throw Object.assign(
      new Error(`Unsupported image type: ${file.type || 'unknown'}`),
      { status: 400 },
    );
  }
  if (file.size > MAX_BANNER_BYTES) {
    throw Object.assign(
      new Error(`Image too large (max ${MAX_BANNER_BYTES / 1024 / 1024} MB)`),
      { status: 400 },
    );
  }

  const ext = MIME_TO_EXT[file.type] ?? 'bin';
  const key = `banners/${crypto.randomUUID()}.${ext}`;
  const buffer = Buffer.from(await file.arrayBuffer());
  await uploadRecording(key, buffer, file.type);

  return { key };
}

// Proxies a banner image from S3 back to the caller. We serve the bytes
// ourselves (instead of 302-redirecting to a presigned URL) so browser
// consumers get our CORS headers — S3 presigned URLs don't include them.
export async function getBannerBytes(filename: string) {
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '');
  if (!safeName) {
    throw Object.assign(new Error('Invalid filename'), { status: 400 });
  }
  const { bytes, contentType } = await getObjectBytes(`banners/${safeName}`);
  const ext = safeName.split('.').pop()?.toLowerCase() ?? '';
  return {
    bytes,
    contentType: contentType ?? MIME_BY_EXT[ext] ?? 'application/octet-stream',
  };
}
