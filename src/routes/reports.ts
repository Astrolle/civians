import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import redis from '../services/redis';
import { authMiddleware } from '../middleware/auth';
import { sendPushToNearbyUsers } from '../services/onesignal';

const router = Router();

export const REPORT_TYPES = [
  'estoy_en_peligro',
  'busco_a_alguien',
  'necesito_ayuda',
  'ofrezco_refugio',
  'informo_algo',
  'estoy_a_salvo',
] as const;

export type ReportType = typeof REPORT_TYPES[number];

// --- Shared location schema ---
const LocationSchema = z.object({
  coordinates:  z.tuple([z.number(), z.number()], {
    errorMap: () => ({ message: 'coordinates [longitude, latitude] are required' }),
  }),
  neighborhood: z.string().max(100).optional(),  // barrio o sector
  city:         z.string().max(100).optional(),
});

// --- Photos: up to 3 URLs (the mobile client uploads to CDN first, sends URLs) ---
const PhotosSchema = z.array(z.string().url()).max(3).optional();

// --- Base fields shared by all report types ---
const BaseReportSchema = z.object({
  type: z.enum(REPORT_TYPES, {
    errorMap: () => ({ message: `type must be one of: ${REPORT_TYPES.join(', ')}` }),
  }),
  message:       z.string().max(1000).optional(),
  location:      LocationSchema,
  contact_phone: z.string().max(20).optional(),
  photos:        PhotosSchema,
});

// --- Amenities only for ofrezco_refugio ---
const AmenitiesSchema = z.object({
  agua_potable:         z.boolean().optional(),  // Agua potable
  comida:               z.boolean().optional(),  // Comida
  espacio_para_dormir:  z.boolean().optional(),  // Espacio para dormir
  ropa_y_abrigo:        z.boolean().optional(),  // Ropa y abrigo
  electricidad:         z.boolean().optional(),  // Electricidad
  carga_de_celular:     z.boolean().optional(),  // Carga de celular
  wifi_senal:           z.boolean().optional(),  // WiFi / señal
  bano_y_ducha:         z.boolean().optional(),  // Baño y ducha
  botiquin_y_medicinas: z.boolean().optional(),  // Botiquín y medicinas
  acepta_mascotas:      z.boolean().optional(),  // Acepta mascotas
  apto_para_ninos:      z.boolean().optional(),  // Apto para niños
  acceso_silla_ruedas:  z.boolean().optional(),  // Acceso silla de ruedas
  capacity:             z.number().int().positive().optional(),  // cuántas personas
  notes:                z.string().max(300).optional(),
});

// --- Full report schema with conditional amenities ---
const ReportSchema = BaseReportSchema.and(
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('ofrezco_refugio'), amenities: AmenitiesSchema.optional() }),
    z.object({ type: z.literal('estoy_en_peligro') }),
    z.object({ type: z.literal('busco_a_alguien'), target_name: z.string().max(100).optional() }),
    z.object({ type: z.literal('necesito_ayuda') }),
    z.object({ type: z.literal('informo_algo') }),
    z.object({ type: z.literal('estoy_a_salvo') }),
  ])
);

// POST /reports
router.post('/', authMiddleware, async (req: Request, res: Response) => {
  const parse = ReportSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: parse.error.flatten().fieldErrors });
  }

  const data = parse.data;
  const deviceId = (req as any).deviceId as string;
  const profile  = (req as any).profile;
  const id       = uuidv4();
  const now      = new Date().toISOString();
  const score    = Date.now();

  const report = {
    id,
    ...data,
    device_id:  deviceId,
    name:       profile.name,
    created_at: now,
    is_active:  true,
  };

  // TTL: 24h
  await redis.set(`report:${id}`, JSON.stringify(report), { EX: 60 * 60 * 24 });
  await redis.zAdd('reports:all',              { score, value: id });
  await redis.zAdd(`reports:type:${data.type}`, { score, value: id });
  await redis.zAdd(`reports:device:${deviceId}`, { score, value: id });

  // Push nearby users only for urgent report types — fire and forget
  const urgentTypes: ReportType[] = ['estoy_en_peligro', 'necesito_ayuda', 'busco_a_alguien'];
  if (urgentTypes.includes(data.type) && data.location) {
    sendPushToNearbyUsers(data.location.coordinates as [number, number], {
      title: `🆘 Reporte cercano: ${data.type.replace(/_/g, ' ')}`,
      body: data.message || `${profile.name} necesita ayuda cerca de ti`,
      data: { report_id: id, type: data.type },
    }).catch((err) => console.error('[Push] Report push failed:', err));
  }

  return res.status(201).json({ message: 'Report submitted', report });
});

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
