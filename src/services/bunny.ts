import axios from 'axios';

// Allowed media types
const ALLOWED_MIME_TYPES: Record<string, string> = {
  'image/jpeg':  'jpg',
  'image/png':   'png',
  'image/webp':  'webp',
  'image/gif':   'gif',
  'video/mp4':   'mp4',
  'video/quicktime': 'mov',
  'video/webm':  'webm',
};

export function isAllowedMimeType(mime: string): boolean {
  return mime in ALLOWED_MIME_TYPES;
}

export function getExtension(mime: string): string {
  return ALLOWED_MIME_TYPES[mime] || 'bin';
}

/**
 * Upload a file buffer to Bunny CDN Storage.
 * Returns the public CDN URL of the uploaded file.
 *
 * Path structure: civians/{folder}/{uuid}.{ext}
 * folder = 'notifications' | 'reports'
 */
export async function uploadToBunny(
  buffer: Buffer,
  mimeType: string,
  folder: 'notifications' | 'reports',
  deviceId: string,
): Promise<string> {
  const storageZone   = process.env.BUNNY_STORAGE_ZONE!;
  const storageApiKey = process.env.BUNNY_STORAGE_API_KEY!;
  const storageHost   = process.env.BUNNY_STORAGE_HOST || 'storage.bunnycdn.com';
  const cdnUrl        = process.env.BUNNY_CDN_URL!; // e.g. https://civians.b-cdn.net

  const ext       = getExtension(mimeType);
  const timestamp = Date.now();
  const safeId    = deviceId.replace(/[^a-zA-Z0-9-_]/g, '_').slice(0, 36);
  const fileName  = `${safeId}-${timestamp}.${ext}`;
  const filePath  = `civians/${folder}/${fileName}`;

  const uploadUrl = `https://${storageHost}/${storageZone}/${filePath}`;

  await axios.put(uploadUrl, buffer, {
    headers: {
      AccessKey:       storageApiKey,
      'Content-Type':  'application/octet-stream',
    },
    maxBodyLength: Infinity,
  });

  // Return the public CDN URL
  return `${cdnUrl}/${filePath}`;
}
