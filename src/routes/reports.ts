import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import redis from '../services/redis';
import { authMiddleware } from '../middleware/auth';
import { sendPushToNearbyUsers } from '../services/onesignal';
import { uploadToBunny, isAllowedMimeType } from '../services/bunny';

const router = Router();

const RADIUS_KM = 5;
const GEO_KEY   = 'reports:geo';

const TTL_DEFAULT  = 60 * 60 * 24;        // 24h
const TTL_OFFER    = 60 * 60 * 24 * 15;  // 15 días

const OFFER_TYPES  = ['ofrezco_refugio', 'ofrezco_ayuda'] as const;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 3 },
});

export const REPORT_TYPES = [
  'estoy_en_peligro',
  'busco_a_alguien',
  'necesito_ayuda',
  'ofrezco_refugio',
  'ofrezco_ayuda',
  'informo_algo',
  'estoy_a_salvo',
] as const;

export type ReportType = typeof REPORT_TYPES[number];

export const REPORT_CATEGORIES = [
  'sismo',
  'inundacion',
  'incendio',
  'deslizamiento',
  'explosion',
  'accidente',
  'acoso',
  'robo',
  'secuestro',
  'conflicto_armado',
  'protesta',
  'otro',
] as const;

export type ReportCategory = typeof REPORT_CATEGORIES[number];

const LocationSchema = z.object({
  coordinates: z.preprocess(
    (val) => {
      if (Array.isArray(val)) return val.map(Number);
      if (typeof val === 'string') {
        try { return JSON.parse(val).map(Number); } catch { return val; }
      }
      return val;
    },
    z.tuple([z.number(), z.number()], {
      errorMap: () => ({ message: 'coordinates [longitude, latitude] are required' }),
    })
  ),
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

export const HELP_SPECIALTIES = [
  'medico',
  'psicologo',
  'abogado',
  'rescatista',
  'bombero',
  'enfermero',
  'ingeniero_estructural',
  'fundacion',
  'voluntario',
  'otro',
] as const;

export type HelpSpecialty = typeof HELP_SPECIALTIES[number];

const ProfessionalHelpSchema = z.object({
  specialty: z.enum(HELP_SPECIALTIES, {
    errorMap: () => ({ message: `specialty must be one of: ${HELP_SPECIALTIES.join(', ')}` }),
  }),
  organization:    z.string().max(150).optional(),
  available_until: z.string().optional(),
  notes:           z.string().max(300).optional(),
});

const BaseReportSchema = z.object({
  type: z.enum(REPORT_TYPES, {
    errorMap: () => ({ message: `type must be one of: ${REPORT_TYPES.join(', ')}` }),
  }),
  message:       z.string().max(1000).optional(),
  location:      z.preprocess(
    (val) => typeof val === 'string' ? JSON.parse(val) : val,
    LocationSchema
  ),
  contact_phone:     z.string().max(20).optional(),
  category:          z.enum(REPORT_CATEGORIES).optional(),
  target_name:       z.string().max(100).optional(),
  amenities:         z.preprocess(
    (val) => typeof val === 'string' ? JSON.parse(val) : val,
    AmenitiesSchema
  ).optional(),
  professional_help: z.preprocess(
    (val) => typeof val === 'string' ? JSON.parse(val) : val,
    ProfessionalHelpSchema
  ).optional(),
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isOffer(type: ReportType): boolean {
  return (OFFER_TYPES as readonly string[]).includes(type);
}

async function enrichWithConfirmations(report: any, deviceId: string) {
  const confirmations   = await redis.sCard(`report:${report.id}:confirms`);
  const confirmed_by_me = await redis.sIsMember(`report:${report.id}:confirms`, deviceId);
  return { ...report, confirmations, confirmed_by_me };
}

// ─── POST /reports ────────────────────────────────────────────────────────────
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

    const invalidFiles = files.filter((f) => !isAllowedMimeType(f.mimetype));
    if (invalidFiles.length > 0) {
      return res.status(400).json({
        error: 'Unsupported file type(s)',
        rejected: invalidFiles.map((f) => ({ name: f.originalname, type: f.mimetype })),
        allowed: ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/quicktime', 'video/webm'],
      });
    }

    let photos: string[] = [];
    if (files.length > 0) {
      const results = await Promise.allSettled(
        files.map((f) => uploadToBunny(f.buffer, f.mimetype, 'reports', deviceId))
      );
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') photos.push(r.value);
        else console.error(`[Bunny] Failed to upload ${files[i].originalname}:`, r.reason);
      });
    }

    const id    = uuidv4();
    const now   = new Date().toISOString();
    const lng   = Number(data.location.coordinates[0]);
    const lat   = Number(data.location.coordinates[1]);
    const offer = isOffer(data.type);

    const report = {
      id,
      ...data,
      photos,
      device_id:  deviceId,
      name:       profile.name,
      created_at: now,
      is_active:  true,
      persistent: offer,  // flag so the client knows this lasts 15 days
    };

    // ofrezco_* → 15 días. Everything else → 24h
    const ttl = offer ? TTL_OFFER : TTL_DEFAULT;
    await redis.set(`report:${id}`, JSON.stringify(report), { EX: ttl });

    await redis.geoAdd(GEO_KEY, { longitude: lng, latitude: lat, member: id });

    // Score starts at timestamp; confirmations will re-score later
    const score = Date.now();
    await redis.zAdd('reports:all',                { score, value: id });
    await redis.zAdd(`reports:type:${data.type}`,  { score, value: id });
    await redis.zAdd(`reports:device:${deviceId}`, { score, value: id });

    const urgentTypes: ReportType[] = ['estoy_en_peligro', 'necesito_ayuda', 'busco_a_alguien'];
    if (urgentTypes.includes(data.type)) {
      sendPushToNearbyUsers([lng, lat], {
        title: `🆘 Reporte cercano: ${data.type.replace(/_/g, ' ')}`,
        body:  data.message || `${profile.name} necesita ayuda cerca de ti`,
        data:  { report_id: id, type: data.type },
      }, deviceId).catch((err) => console.error('[Push] Report push failed:', err));
    }

    return res.status(201).json({ message: 'Report submitted', report });
  }
);

// ─── GET /reports ─────────────────────────────────────────────────────────────
router.get('/', authMiddleware, async (req: Request, res: Response) => {
  const lat  = parseFloat(req.query.latitude  as string);
  const lng  = parseFloat(req.query.longitude as string);
  const type = req.query.type as string | undefined;

  if (isNaN(lat) || isNaN(lng)) {
    return res.status(400).json({
      error: 'latitude and longitude query params are required.',
      example: '/reports?latitude=6.2442&longitude=-75.5812',
    });
  }

  const nearbyIds = await redis.geoSearch(
    GEO_KEY,
    { longitude: lng, latitude: lat },
    { radius: RADIUS_KM, unit: 'km' },
    { COUNT: 200, SORT: 'ASC' }
  );

  if (!nearbyIds.length) {
    return res.json({ reports: [], total: 0, radius_km: RADIUS_KM });
  }

  const raws = await Promise.all(nearbyIds.map((id) => redis.get(`report:${id}`)));

  let reports = raws
    .filter(Boolean)
    .map((r) => JSON.parse(r!))
    .filter((r) => r.is_active);

  if (type) reports = reports.filter((r) => r.type === type);

  // Enrich with confirmations
  const enriched = await Promise.all(
    reports.map((r) => enrichWithConfirmations(r, (req as any).deviceId))
  );

  // Sort by confirmations DESC (highest ranked first)
  enriched.sort((a, b) => b.confirmations - a.confirmations);

  return res.json({ reports: enriched, total: enriched.length, radius_km: RADIUS_KM });
});

// ─── GET /reports/me ──────────────────────────────────────────────────────────
router.get('/me', authMiddleware, async (req: Request, res: Response) => {
  const deviceId = (req as any).deviceId as string;
  const ids = (await redis.zRange(`reports:device:${deviceId}`, 0, -1, { REV: true })) as string[];

  if (!ids.length) return res.json({ reports: [] });

  const raws   = await Promise.all(ids.map((id) => redis.get(`report:${id}`)));
  const reports = await Promise.all(
    raws
      .filter(Boolean)
      .map((r) => JSON.parse(r!))
      .map((r) => enrichWithConfirmations(r, deviceId))
  );

  return res.json({ reports });
});

// ─── GET /reports/:id ─────────────────────────────────────────────────────────
router.get('/:id', authMiddleware, async (req: Request, res: Response) => {
  const raw = await redis.get(`report:${req.params.id}`);
  if (!raw) return res.status(404).json({ error: 'Report not found or expired' });

  const report = await enrichWithConfirmations(JSON.parse(raw), (req as any).deviceId);
  return res.json({ report });
});

// ─── POST /reports/:id/confirm ────────────────────────────────────────────────
router.post('/:id/confirm', authMiddleware, async (req: Request, res: Response) => {
  const { id }   = req.params;
  const deviceId = (req as any).deviceId as string;

  const raw = await redis.get(`report:${id}`);
  if (!raw) return res.status(404).json({ error: 'Report not found or expired' });

  const alreadyConfirmed = await redis.sIsMember(`report:${id}:confirms`, deviceId);
  if (alreadyConfirmed) {
    return res.status(409).json({ error: 'You already confirmed this report.' });
  }

  await redis.sAdd(`report:${id}:confirms`, deviceId);
  const confirmations = await redis.sCard(`report:${id}:confirms`);

  // Re-score sorted sets by confirmation count
  const report = JSON.parse(raw);
  await redis.zAdd('reports:all',                    { score: confirmations, value: id });
  await redis.zAdd(`reports:type:${report.type}`,    { score: confirmations, value: id });
  await redis.zAdd(`reports:device:${report.device_id}`, { score: confirmations, value: id });

  return res.json({ message: 'Report confirmed', confirmations });
});

// ─── DELETE /reports/:id/confirm ──────────────────────────────────────────────
router.delete('/:id/confirm', authMiddleware, async (req: Request, res: Response) => {
  const { id }   = req.params;
  const deviceId = (req as any).deviceId as string;

  const raw = await redis.get(`report:${id}`);
  if (!raw) return res.status(404).json({ error: 'Report not found or expired' });

  const wasConfirmed = await redis.sIsMember(`report:${id}:confirms`, deviceId);
  if (!wasConfirmed) {
    return res.status(409).json({ error: 'You have not confirmed this report.' });
  }

  await redis.sRem(`report:${id}:confirms`, deviceId);
  const confirmations = await redis.sCard(`report:${id}:confirms`);

  const report = JSON.parse(raw);
  await redis.zAdd('reports:all',                    { score: confirmations, value: id });
  await redis.zAdd(`reports:type:${report.type}`,    { score: confirmations, value: id });
  await redis.zAdd(`reports:device:${report.device_id}`, { score: confirmations, value: id });

  return res.json({ message: 'Confirmation removed', confirmations });
});

// ─── DELETE /reports/:id ──────────────────────────────────────────────────────
router.delete('/:id', authMiddleware, async (req: Request, res: Response) => {
  const raw = await redis.get(`report:${req.params.id}`);
  if (!raw) return res.status(404).json({ error: 'Report not found or expired' });

  const report = JSON.parse(raw);
  if (report.device_id !== (req as any).deviceId) {
    return res.status(403).json({ error: 'You can only delete your own reports' });
  }

  const deactivated = { ...report, is_active: false, deactivated_at: new Date().toISOString() };
  await redis.set(`report:${req.params.id}`, JSON.stringify(deactivated), { KEEPTTL: true });
  await redis.zRem(GEO_KEY, report.id);

  return res.json({ message: 'Report deactivated' });
});

export default router;
