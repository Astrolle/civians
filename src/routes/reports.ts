import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import redis from '../services/redis';
import { authMiddleware } from '../middleware/auth';
import { sendPushToNearbyUsers } from '../services/onesignal';
import { uploadToBunny, isAllowedMimeType } from '../services/bunny';

const router = Router();

// Multer — memory storage, up to 3 files, 50MB each
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 3 },
});

export const REPORT_TYPES = [
  'estoy_en_peligro',
  'busco_a_alguien',
  'necesito_ayuda',
  'ofrezco_refugio',
  'informo_algo',
  'estoy_a_salvo',
] as const;

export type ReportType = typeof REPORT_TYPES[number];

const LocationSchema = z.object({
  coordinates:  z.tuple([
    z.coerce.number(),  // coerce because multipart sends strings
    z.coerce.number(),
  ], { errorMap: () => ({ message: 'coordinates [longitude, latitude] are required' }) }),
  neighborhood: z.string().max(100).optional(),
  city:         z.string().max(100).optional(),
});

const AmenitiesSchema = z.object({
  agua_potable:         z.coerce.boolean().optional(),
  comida:               z.coerce.boolean().optional(),
  espacio_para_dormir:  z.coerce.boolean().optional(),
  ropa_y_abrigo:        z.coerce.boolean().optional(),
  electricidad:         z.coerce.boolean().optional(),
  carga_de_celular:     z.coerce.boolean().optional(),
  wifi_senal:           z.coerce.boolean().optional(),
  bano_y_ducha:         z.coerce.boolean().optional(),
  botiquin_y_medicinas: z.coerce.boolean().optional(),
  acepta_mascotas:      z.coerce.boolean().optional(),
  apto_para_ninos:      z.coerce.boolean().optional(),
  acceso_silla_ruedas:  z.coerce.boolean().optional(),
  capacity:             z.coerce.number().int().positive().optional(),
  notes:                z.string().max(300).optional(),
});

// Base schema — all fields coerced from strings (multipart sends everything as string)
const BaseReportSchema = z.object({
  type: z.enum(REPORT_TYPES, {
    errorMap: () => ({ message: `type must be one of: ${REPORT_TYPES.join(', ')}` }),
  }),
  message:       z.string().max(1000).optional(),
  location:      z.preprocess(
    (val) => typeof val === 'string' ? JSON.parse(val) : val,
    LocationSchema
  ),
  contact_phone: z.string().max(20).optional(),
  amenities:     z.preprocess(
    (val) => typeof val === 'string' ? JSON.parse(val) : val,
    AmenitiesSchema
  ).optional(),
  target_name:   z.string().max(100).optional(),
});

// POST /reports — multipart/form-data
router.post(
  '/',
  authMiddleware,
  upload.array('files', 3),
  async (req: Request, res: Response) => {
    const parse = BaseReportSchema.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({ error: parse.error.flatten().fieldErrors });
    }

    const data     = parse.data;
    const deviceId = (req as any).deviceId as string;
    const profile  = (req as any).profile;
    const files    = (req.files as Express.Multer.File[]) || [];

    // Validate file types
    const invalidFiles = files.filter((f) => !isAllowedMimeType(f.mimetype));
    if (invalidFiles.length > 0) {
      return res.status(400).json({
        error: 'Unsupported file type(s)',
        rejected: invalidFiles.map((f) => ({ name: f.originalname, type: f.mimetype })),
        allowed: ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/quicktime', 'video/webm'],
      });
    }

    // Upload files to Bunny CDN in parallel
    let photos: string[] = [];
    if (files.length > 0) {
      const results = await Promise.allSettled(
        files.map((f) => uploadToBunny(f.buffer, f.mimetype, 'reports', deviceId))
      );
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') {
          photos.push(r.value);
        } else {
          console.error(`[Bunny] Failed to upload ${files[i].originalname}:`, r.reason);
        }
      });
    }

    const id    = uuidv4();
    const now   = new Date().toISOString();
    const score = Date.now();

    const report = {
      id,
      ...data,
      photos,
      device_id:  deviceId,
      name:       profile.name,
      created_at: now,
      is_active:  true,
    };

    await redis.set(`report:${id}`, JSON.stringify(report), { EX: 60 * 60 * 24 });
    await redis.zAdd('reports:all',               { score, value: id });
    await redis.zAdd(`reports:type:${data.type}`, { score, value: id });
    await redis.zAdd(`reports:device:${deviceId}`, { score, value: id });

    const urgentTypes: ReportType[] = ['estoy_en_peligro', 'necesito_ayuda', 'busco_a_alguien'];
    if (urgentTypes.includes(data.type) && data.location) {
      sendPushToNearbyUsers(data.location.coordinates as [number, number], {
        title: `🆘 Reporte cercano: ${data.type.replace(/_/g, ' ')}`,
        body:  data.message || `${profile.name} necesita ayuda cerca de ti`,
        data:  { report_id: id, type: data.type },
      }).catch((err) => console.error('[Push] Report push failed:', err));
    }

    return res.status(201).json({ message: 'Report submitted', report });
  }
);

// GET /reports
router.get('/', authMiddleware, async (req: Request, res: Response) => {
  const limit  = parseInt(req.query.limit  as string) || 50;
  const offset = parseInt(req.query.offset as string) || 0;
  const type   = req.query.type as string | undefined;

  const setKey = type ? `reports:type:${type}` : 'reports:all';
  const ids    = (await redis.zRange(setKey, offset, offset + limit - 1, { REV: true })) as string[];
  const total  = await redis.zCard(setKey);

  if (!ids.length) return res.json({ reports: [], total: 0 });

  const raws   = await Promise.all(ids.map((id) => redis.get(`report:${id}`)));
  const reports = raws
    .filter(Boolean)
    .map((r) => JSON.parse(r!))
    .filter((r) => r.is_active);

  return res.json({ reports, total, limit, offset });
});

// GET /reports/me
router.get('/me', authMiddleware, async (req: Request, res: Response) => {
  const deviceId = (req as any).deviceId as string;
  const ids = (await redis.zRange(`reports:device:${deviceId}`, 0, -1, { REV: true })) as string[];

  if (!ids.length) return res.json({ reports: [] });

  const raws   = await Promise.all(ids.map((id) => redis.get(`report:${id}`)));
  const reports = raws.filter(Boolean).map((r) => JSON.parse(r!));

  return res.json({ reports });
});

// GET /reports/:id
router.get('/:id', authMiddleware, async (req: Request, res: Response) => {
  const raw = await redis.get(`report:${req.params.id}`);
  if (!raw) return res.status(404).json({ error: 'Report not found or expired' });
  return res.json({ report: JSON.parse(raw) });
});

// DELETE /reports/:id
router.delete('/:id', authMiddleware, async (req: Request, res: Response) => {
  const raw = await redis.get(`report:${req.params.id}`);
  if (!raw) return res.status(404).json({ error: 'Report not found or expired' });

  const report = JSON.parse(raw);
  if (report.device_id !== (req as any).deviceId) {
    return res.status(403).json({ error: 'You can only delete your own reports' });
  }

  const deactivated = { ...report, is_active: false, deactivated_at: new Date().toISOString() };
  await redis.set(`report:${req.params.id}`, JSON.stringify(deactivated), { KEEPTTL: true });

  return res.json({ message: 'Report deactivated' });
});

export default router;
