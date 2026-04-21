import { uploadRecording, getPresignedUrl } from '../lib/s3';

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

// 7 days — banner URLs are regenerated each time the room is fetched, so the
// TTL just needs to outlive a typical session.
const BANNER_URL_TTL_SECONDS = 60 * 60 * 24 * 7;

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

// Returns a time-limited presigned URL to a banner object. Used by the public
// /assets/banners/:filename redirect so the S3 bucket itself can stay private.
export async function getBannerPresignedUrl(filename: string) {
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '');
  if (!safeName) {
    throw Object.assign(new Error('Invalid filename'), { status: 400 });
  }
  return getPresignedUrl(`banners/${safeName}`, BANNER_URL_TTL_SECONDS);
}
