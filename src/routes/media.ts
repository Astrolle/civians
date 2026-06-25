import { Router, Request, Response } from 'express';
import multer from 'multer';
import { authMiddleware } from '../middleware/auth';
import { uploadToBunny, isAllowedMimeType } from '../services/bunny';

const router = Router();

// Store file in memory (buffer) — no disk writes
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB max
    files: 3,                   // max 3 files per request
  },
});

/**
 * POST /media/upload
 *
 * Multipart form-data. Fields:
 *   - files: 1–3 files (image or video)
 *   - folder: 'notifications' | 'reports' (optional, defaults to 'notifications')
 *
 * Returns an array of CDN URLs ready to use in media[] field.
 */
router.post(
  '/upload',
  authMiddleware,
  upload.array('files', 3),
  async (req: Request, res: Response) => {
    const files = req.files as Express.Multer.File[];

    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded. Use field name "files".' });
    }

    const folder = (req.body.folder === 'reports' ? 'reports' : 'notifications') as
      'notifications' | 'reports';

    // Validate mime types before uploading anything
    const invalid = files.filter((f) => !isAllowedMimeType(f.mimetype));
    if (invalid.length > 0) {
      return res.status(400).json({
        error: 'Unsupported file type(s).',
        rejected: invalid.map((f) => ({ name: f.originalname, type: f.mimetype })),
        allowed: ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/quicktime', 'video/webm'],
      });
    }

    // Upload all files in parallel
    const results = await Promise.allSettled(
      files.map((f) => uploadToBunny(f.buffer, f.mimetype, folder, (req as any).deviceId))
    );

    const urls: string[]   = [];
    const errors: string[] = [];

    results.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        urls.push(result.value);
      } else {
        errors.push(`${files[i].originalname}: ${result.reason?.message || 'Upload failed'}`);
      }
    });

    if (urls.length === 0) {
      return res.status(500).json({ error: 'All uploads failed', details: errors });
    }

    return res.status(201).json({
      message: `${urls.length} file(s) uploaded successfully`,
      urls,       // ← use these in media[] when creating notifications or reports
      ...(errors.length > 0 && { partial_errors: errors }),
    });
  }
);

export default router;
