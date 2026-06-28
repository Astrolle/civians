import axios from 'axios';

const ALLOWED_MIME_TYPES: Record<string, string> = {
  'image/jpeg':       'jpg',
  'image/png':        'png',
  'image/webp':       'webp',
  'image/gif':        'gif',
  'video/mp4':        'mp4',
  'video/quicktime':  'mov',
  'video/webm':       'webm',
  'video/x-m4v':      'mp4',
  'video/3gpp':       '3gp',
  'video/3gpp2':      '3g2',
  'video/mpeg':       'mpg',
  'video/x-msvideo':  'avi',
  // Fallbacks for when React Native sends generic types
  'video/*':          'mp4',
  'application/octet-stream': 'mp4', // binary fallback — treat as video
};

export function isAllowedMimeType(mime: string): boolean {
  if (!mime) return false;
  // Accept any video/* type
  if (mime.startsWith('video/')) return true;
  return mime in ALLOWED_MIME_TYPES;
}

export function getExtension(mime: string, originalName?: string): string {
  // Try to get extension from original filename first
  if (originalName) {
    const ext = originalName.split('.').pop()?.toLowerCase();
    if (ext && ['jpg','jpeg','png','webp','gif','mp4','mov','webm','3gp','avi','mpg'].includes(ext)) {
      return ext === 'jpeg' ? 'jpg' : ext;
    }
  }
  return ALLOWED_MIME_TYPES[mime] || (mime.startsWith('video/') ? 'mp4' : 'bin');
}

function resolveZoneName(raw: string): string {
  return raw
    .replace(/^https?:\/\/[^/]+\//, '')
    .replace(/\/$/, '');
}

const UPLOAD_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes for large videos

export async function uploadToBunny(
  buffer: Buffer,
  mimeType: string,
  folder: 'notifications' | 'reports',
  deviceId: string,
  originalName?: string,
): Promise<string> {
  const rawZone   = process.env.BUNNY_STORAGE_ZONE!;
  const apiKey    = process.env.BUNNY_STORAGE_API_KEY!;
  const host      = process.env.BUNNY_STORAGE_HOST || 'ny.storage.bunnycdn.com';
  const cdnUrl    = (process.env.BUNNY_CDN_URL || '').replace(/\/$/, '');

  const zoneName  = resolveZoneName(rawZone);
  const ext       = getExtension(mimeType, originalName);
  const timestamp = Date.now();
  const safeId    = deviceId.replace(/[^a-zA-Z0-9-_]/g, '_').slice(0, 36);
  const fileName  = `${safeId}-${timestamp}.${ext}`;
  const filePath  = `civians/${folder}/${fileName}`;
  const uploadUrl = `https://${host}/${zoneName}/${filePath}`;
  const publicUrl = `${cdnUrl}/${filePath}`;

  console.log(`[Bunny] Uploading ${mimeType} (${(buffer.length / 1024 / 1024).toFixed(2)}MB) → ${uploadUrl}`);

  await axios.put(uploadUrl, buffer, {
    headers: {
      AccessKey:      apiKey,
      'Content-Type': 'application/octet-stream',
    },
    maxBodyLength:    Infinity,
    maxContentLength: Infinity,
    timeout:          UPLOAD_TIMEOUT_MS,
    onUploadProgress: (e) => {
      if (e.total) {
        const pct = Math.round((e.loaded / e.total) * 100);
        console.log(`[Bunny] Upload progress: ${pct}%`);
      }
    },
  });

  console.log(`[Bunny] Upload success → ${publicUrl}`);
  return publicUrl;
}
