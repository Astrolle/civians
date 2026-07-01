import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import { getCollection } from '../services/db';
import { authMiddleware } from '../middleware/auth';
import { sendPushToNearbyUsers } from '../services/onesignal';
import { uploadToBunny, isAllowedMimeType } from '../services/bunny';

const router = Router();

const RADIUS_KM = 5;

// null = no expiry (MongoDB TTL index won't touch it)
const TTL: Record<string, number | null> = {
  estoy_en_peligro: 60 * 60 * 24 * 4,   // 4 días
  necesito_ayuda:   60 * 60 * 24 * 4,   // 4 días
  informo_algo:     60 * 60 * 24 * 4,   // 4 días
  busco_a_alguien:  60 * 60 * 24 * 5,   // 5 días
  busco_mi_mascota: 60 * 60 * 24 * 5,   // 5 días
  ofrezco_refugio:  null,                // ∞ sin expiración
  ofrezco_ayuda:    60 * 60 * 24 * 21,  // 21 días
  estoy_a_salvo:    60 * 60 * 24 * 7,   // 7 días
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024, files: 3 },
});

export const REPORT_TYPES = [
  'estoy_en_peligro', 'busco_a_alguien', 'busco_mi_mascota', 'necesito_ayuda',
  'ofrezco_refugio', 'ofrezco_ayuda', 'informo_algo', 'estoy_a_salvo',
] as const;

export type ReportType = typeof REPORT_TYPES[number];

export const REPORT_CATEGORIES = [
  'sismo', 'inundacion', 'incendio', 'deslizamiento', 'explosion', 'accidente',
  'acoso', 'robo', 'secuestro', 'conflicto_armado', 'protesta', 'otro',
] as const;

export const HELP_SPECIALTIES = [
  'medico', 'psicologo', 'abogado', 'rescatista', 'bombero',
  'enfermero', 'ingeniero_estructural', 'fundacion', 'voluntario', 'otro',
] as const;

const LocationSchema = z.object({
  coordinates: z.preprocess(
    (val) => {
      if (Array.isArray(val)) return val.map(Number);
      if (typeof val === 'string') { try { return JSON.parse(val).map(Number); } catch { return val; } }
      return val;
    },
    z.tuple([z.number(), z.number()], { errorMap: () => ({ message: 'coordinates [longitude, latitude] are required' }) })
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

const ProfessionalHelpSchema = z.object({
  specialty:       z.enum(HELP_SPECIALTIES),
  organization:    z.string().max(150).optional(),
  available_until: z.string().optional(),
  notes:           z.string().max(300).optional(),
});

// Status only for busco_a_alguien and busco_mi_mascota
export const SEARCH_STATUSES = [
  'buscando',     // default — still missing
  'encontrado',   // found alive
  'fallecido',    // confirmed deceased
] as const;

export type SearchStatus = typeof SEARCH_STATUSES[number];

const BaseReportSchema = z.object({
  type: z.enum(REPORT_TYPES),
  message:       z.string().max(1000).optional(),
  location:      z.preprocess((val) => typeof val === 'string' ? JSON.parse(val) : val, LocationSchema),
  contact_phone: z.string().max(20).optional(),
  category:      z.enum(REPORT_CATEGORIES).optional(),
  target_name:   z.string().max(100).optional(),
  // Status for busco_a_alguien and busco_mi_mascota
  status: z.enum(SEARCH_STATUSES).optional(),

  // For busco_a_alguien — open-ended characteristics, any key/value pair
  person_details: z.preprocess(
    (val) => typeof val === 'string' ? JSON.parse(val) : val,
    z.record(z.string(), z.string()).optional()
  ),
  // For busco_mi_mascota — pet characteristics
  pet_details: z.preprocess(
    (val) => typeof val === 'string' ? JSON.parse(val) : val,
    z.record(z.string(), z.string()).optional()
  ),
  amenities:     z.preprocess((val) => typeof val === 'string' ? JSON.parse(val) : val, AmenitiesSchema).optional(),
  professional_help: z.preprocess((val) => typeof val === 'string' ? JSON.parse(val) : val, ProfessionalHelpSchema).optional(),
});

function rankingScore(confirmations: number, dist_km: number): number {
  return (confirmations * 10) - dist_km;
}

function calcDistKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R  = 6371;
  const dL = ((lat2 - lat1) * Math.PI) / 180;
  const dl = ((lng2 - lng1) * Math.PI) / 180;
  const a  = Math.sin(dL / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dl / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 100) / 100;
}

// ─── POST /reports ────────────────────────────────────────────────────────────
router.post('/', authMiddleware, upload.array('files', 3), async (req: Request, res: Response) => {
  console.log('[POST /reports] Content-Type:', req.headers['content-type']);
  console.log('[POST /reports] body keys:', Object.keys(req.body));
  console.log('[POST /reports] files count:', Array.isArray(req.files) ? (req.files as any[]).length : 0);

  const parse = BaseReportSchema.safeParse(req.body);
  if (!parse.success) {
    console.log('[POST /reports] validation errors:', JSON.stringify(parse.error.flatten().fieldErrors));
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
    });
  }

  let photos: string[] = [];
  if (files.length > 0) {
    const results = await Promise.allSettled(
      files.map((f) => uploadToBunny(f.buffer, f.mimetype, 'reports', deviceId, f.originalname))
    );
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') photos.push(r.value);
      else console.error(`[Bunny] Failed to upload ${files[i].originalname}:`, r.reason);
    });
  }

  const id         = uuidv4();
  const now        = new Date();
  const [lng, lat] = data.location.coordinates;
  const ttlSecs    = TTL[data.type] ?? 60 * 60 * 24 * 4;
  const isPermanent = ttlSecs === null;

  const doc: any = {
    _id:        id,
    ...data,
    location: {
      ...data.location,
      geo: { type: 'Point', coordinates: [lng, lat] },
    },
    photos,
    device_id:     deviceId,
    name:          profile.name,
    // Default status for search reports
    status: ['busco_a_alguien', 'busco_mi_mascota'].includes(data.type)
      ? (data.status || 'buscando')
      : undefined,
    status_note:       null,
    status_updated_at: null,
    confirmations: 0,
    confirmed_by:  [] as string[],
    created_at:    now,
    is_active:     true,
    ttl_days:      isPermanent ? null : Math.round(ttlSecs / (60 * 60 * 24)),
    expires_at:    isPermanent ? null : new Date(now.getTime() + ttlSecs * 1000),
    // Warning sent flag — for trigger to track
    expiry_warning_sent: false,
  };

  await getCollection('reports').insertOne(doc as any);

  const urgentTypes: ReportType[] = ['estoy_en_peligro', 'necesito_ayuda', 'busco_a_alguien', 'busco_mi_mascota'];
  if (urgentTypes.includes(data.type)) {
    sendPushToNearbyUsers([lng, lat], {
      title: `🆘 Reporte cercano: ${data.type.replace(/_/g, ' ')}`,
      body:  data.message || `${profile.name} necesita ayuda cerca de ti`,
      data:  { report_id: id, type: data.type },
    }, deviceId).catch((err) => console.error('[Push]', err));
  }

  return res.status(201).json({ message: 'Report submitted', report: { ...doc, _id: undefined, id } });
});

// ─── GET /reports/map ─────────────────────────────────────────────────────────
router.get('/map', authMiddleware, async (req: Request, res: Response) => {
  const type   = req.query.type as string | undefined;
  const filter: any = { is_active: true };
  if (type) filter.type = type;

  const docs = await getCollection('reports').find(filter, {
    projection: { _id: 1, type: 1, category: 1, name: 1, location: 1, created_at: 1, ttl_days: 1 },
  }).limit(500).toArray();

  const reports = docs.map((doc: any) => ({
    id:          doc._id,
    type:        doc.type,
    category:    doc.category ?? null,
    name:        doc.name,
    coordinates: doc.location.coordinates,
    location:    doc.location,
    created_at:  doc.created_at,
    ttl_days:    doc.ttl_days,
  }));

  return res.json({ reports, total: reports.length });
});

// ─── GET /reports ─────────────────────────────────────────────────────────────
router.get('/', authMiddleware, async (req: Request, res: Response) => {
  const lat      = parseFloat(req.query.latitude  as string);
  const lng      = parseFloat(req.query.longitude as string);
  const type     = req.query.type as string | undefined;
  const deviceId = (req as any).deviceId as string;

  if (isNaN(lat) || isNaN(lng)) {
    return res.status(400).json({ error: 'latitude and longitude query params are required.', example: '/reports?latitude=6.2442&longitude=-75.5812' });
  }

  const filter: any = {
    is_active: true,
    'location.geo': {
      $near: {
        $geometry:    { type: 'Point', coordinates: [lng, lat] },
        $maxDistance: RADIUS_KM * 1000,
      },
    },
  };

  if (type) filter.type = type;

  const docs = await getCollection('reports').find(filter).limit(200).toArray();

  const reports = docs.map((doc: any) => {
    const dist_km = calcDistKm(lat, lng, doc.location.coordinates[1], doc.location.coordinates[0]);
    const confirmed_by_me = (doc.confirmed_by || []).includes(deviceId);
    return { ...doc, _id: undefined, id: doc._id, dist_km, confirmed_by_me };
  });

  reports.sort((a, b) => rankingScore(b.confirmations, b.dist_km) - rankingScore(a.confirmations, a.dist_km));

  return res.json({ reports, total: reports.length, radius_km: RADIUS_KM });
});

// ─── GET /reports/me ──────────────────────────────────────────────────────────
router.get('/me', authMiddleware, async (req: Request, res: Response) => {
  const deviceId = (req as any).deviceId as string;

  const docs = await getCollection('reports')
    .find({ device_id: deviceId })
    .sort({ created_at: -1 })
    .toArray();

  const reports = docs.map((doc) => ({ ...doc, _id: undefined, id: doc._id, confirmed_by_me: (doc.confirmed_by || []).includes(deviceId) }));

  return res.json({ reports, total: reports.length });
});

// ─── GET /reports/search — filter by message/target/type/location ──────────
// Text search across active reports. Independent of proximity, mirrors
// GET /collection-centers/search. Optionally sorted by distance if
// latitude/longitude are provided.
router.get('/search', authMiddleware, async (req: Request, res: Response) => {
  const q = (req.query.q as string || '').trim();
  if (!q) {
    return res.status(400).json({ error: 'q (search text) is required.' });
  }

  const lat = parseFloat(req.query.latitude  as string);
  const lng = parseFloat(req.query.longitude as string);
  const hasCoords = !isNaN(lat) && !isNaN(lng);
  const deviceId  = (req as any).deviceId as string;

  const type = req.query.type as string | undefined;

  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(escaped, 'i');

  const filter: any = {
    is_active: true,
    $or: [
      { message:                 regex },
      { target_name:             regex },
      { type:                    regex },
      { category:                regex },
      { name:                    regex }, // reporter's name
      { 'location.city':         regex },
      { 'location.neighborhood': regex },
    ],
  };
  if (type) filter.type = type;

  const docs = await getCollection('reports').find(filter).limit(100).toArray();

  let reports = docs.map((doc: any) => {
    const confirmed_by_me = (doc.confirmed_by || []).includes(deviceId);
    const base = { ...doc, _id: undefined, id: doc._id, confirmed_by_me };
    if (hasCoords && doc.location?.coordinates?.length === 2) {
      return { ...base, dist_km: calcDistKm(lat, lng, doc.location.coordinates[1], doc.location.coordinates[0]) };
    }
    return base;
  });

  if (hasCoords) {
    reports = reports.sort((a: any, b: any) => (a.dist_km ?? Infinity) - (b.dist_km ?? Infinity));
  }

  return res.json({ reports, total: reports.length, query: q });
});

// ─── GET /reports/:id ─────────────────────────────────────────────────────────
router.get('/:id', authMiddleware, async (req: Request, res: Response) => {
  const doc = await getCollection('reports').findOne({ _id: req.params.id as any });
  if (!doc) return res.status(404).json({ error: 'Report not found or expired' });
  const deviceId = (req as any).deviceId as string;
  return res.json({ report: { ...doc, _id: undefined, id: doc._id, confirmed_by_me: (doc.confirmed_by || []).includes(deviceId) } });
});

// ─── PATCH /reports/:id ───────────────────────────────────────────────────────
router.patch('/:id', authMiddleware, upload.array('files', 3), async (req: Request, res: Response) => {
  const col = getCollection('reports');
  const doc = await col.findOne({ _id: req.params.id as any });
  if (!doc) return res.status(404).json({ error: 'Report not found or expired' });
  if (doc.device_id !== (req as any).deviceId) return res.status(403).json({ error: 'You can only edit your own reports' });

  const parse = BaseReportSchema.partial().safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: parse.error.flatten().fieldErrors });

  const files    = (req.files as Express.Multer.File[]) || [];
  const deviceId = (req as any).deviceId as string;
  let photos     = doc.photos || [];

  if (files.length > 0) {
    const results = await Promise.allSettled(
      files.map((f) => uploadToBunny(f.buffer, f.mimetype, 'reports', deviceId, f.originalname))
    );
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') photos.push(r.value);
      else console.error(`[Bunny] Failed to upload ${files[i].originalname}:`, r.reason);
    });
  }

  const update: any = { ...parse.data, photos, updated_at: new Date() };
  if (parse.data.location) {
    const [lng, lat] = parse.data.location.coordinates as [number, number];
    update['location.geo'] = { type: 'Point', coordinates: [lng, lat] };
  }

  await col.updateOne({ _id: req.params.id as any }, { $set: update });
  const updated = await col.findOne({ _id: req.params.id as any });
  return res.json({ message: 'Report updated', report: { ...updated, _id: undefined, id: updated!._id } });
});

// ─── PATCH /reports/:id/status — update search status (owner only) ─────────────
router.patch('/:id/status', authMiddleware, async (req: Request, res: Response) => {
  const col = getCollection('reports');
  const doc = await col.findOne({ _id: req.params.id as any });
  if (!doc) return res.status(404).json({ error: 'Report not found or expired' });
  if (doc.device_id !== (req as any).deviceId) {
    return res.status(403).json({ error: 'You can only update the status of your own reports.' });
  }

  const SEARCH_TYPES = ['busco_a_alguien', 'busco_mi_mascota'];
  if (!SEARCH_TYPES.includes(doc.type)) {
    return res.status(400).json({ error: 'Status can only be updated on busco_a_alguien or busco_mi_mascota reports.' });
  }

  const parse = z.object({
    status:  z.enum(SEARCH_STATUSES),
    note:    z.string().max(300).optional(), // optional note e.g. "Encontrado en Hospital Vargas"
  }).safeParse(req.body);

  if (!parse.success) return res.status(400).json({ error: parse.error.flatten().fieldErrors });

  const { status, note } = parse.data;
  const now = new Date();

  await col.updateOne({ _id: req.params.id as any }, {
    $set: {
      status,
      status_note:      note ?? null,
      status_updated_at: now,
    },
  });

  // Notify all users who confirmed this report via OneSignal
  const confirmedBy: string[] = doc.confirmed_by || [];
  if (confirmedBy.length > 0) {
    const statusLabels: Record<string, string> = {
      encontrado: '✅ ¡Buenas noticias!',
      fallecido:  '🕊️ Actualización importante',
      buscando:   '🔍 Actualización de búsqueda',
    };

    const statusMessages: Record<string, string> = {
      encontrado: `${doc.target_name || 'La persona'} fue encontrada${note ? `: ${note}` : '.'}`,
      fallecido:  `${doc.target_name || 'La persona'} ha fallecido${note ? `. ${note}` : '.'}`,
      buscando:   `Actualización en la búsqueda de ${doc.target_name || 'la persona'}${note ? `: ${note}` : '.'}`,
    };

    const axios = (await import('axios')).default;
    try {
      await axios.post('https://api.onesignal.com/notifications?c=push', {
        app_id:          process.env.ONESIGNAL_APP_ID!,
        include_aliases: { external_id: confirmedBy },
        target_channel:  'push',
        headings: { en: statusLabels[status] },
        contents: { en: statusMessages[status] },
        data: { report_id: req.params.id, type: doc.type, status, action: 'status_update' },
        priority: 8,
      }, {
        headers: {
          'Content-Type': 'application/json',
          Authorization:  `Key ${process.env.ONESIGNAL_API_KEY!}`,
        },
      });
      console.log(`[Status] Notified ${confirmedBy.length} user(s) about status change: ${status}`);
    } catch (err: any) {
      console.error('[Status] Push failed:', err?.response?.data || err.message);
    }
  }

  return res.json({
    message:           'Status updated',
    status,
    status_note:       note ?? null,
    status_updated_at: now,
    notified_users:    confirmedBy.length,
  });
});

// ─── POST /reports/:id/confirm ────────────────────────────────────────────────
router.post('/:id/confirm', authMiddleware, async (req: Request, res: Response) => {
  const col      = getCollection('reports');
  const deviceId = (req as any).deviceId as string;
  const doc      = await col.findOne({ _id: req.params.id as any });
  if (!doc) return res.status(404).json({ error: 'Report not found or expired' });
  if ((doc.confirmed_by || []).includes(deviceId)) return res.status(409).json({ error: 'You already confirmed this report.' });

  await col.updateOne({ _id: req.params.id as any }, { $addToSet: { confirmed_by: deviceId }, $inc: { confirmations: 1 } });
  return res.json({ message: 'Report confirmed', confirmations: (doc.confirmations || 0) + 1 });
});

// ─── DELETE /reports/:id/confirm ──────────────────────────────────────────────
router.delete('/:id/confirm', authMiddleware, async (req: Request, res: Response) => {
  const col      = getCollection('reports');
  const deviceId = (req as any).deviceId as string;
  const doc      = await col.findOne({ _id: req.params.id as any });
  if (!doc) return res.status(404).json({ error: 'Report not found or expired' });
  if (!(doc.confirmed_by || []).includes(deviceId)) return res.status(409).json({ error: 'You have not confirmed this report.' });

  await col.updateOne({ _id: req.params.id as any }, { $pull: { confirmed_by: deviceId } as any, $inc: { confirmations: -1 } });
  return res.json({ message: 'Confirmation removed', confirmations: Math.max(0, (doc.confirmations || 1) - 1) });
});

// ─── POST /reports/:id/extend — extend expiry (owner only) ──────────────────
router.post('/:id/extend', authMiddleware, async (req: Request, res: Response) => {
  const col = getCollection('reports');
  const doc = await col.findOne({ _id: req.params.id as any });
  if (!doc) return res.status(404).json({ error: 'Report not found' });
  if (doc.device_id !== (req as any).deviceId) {
    return res.status(403).json({ error: 'You can only extend your own reports.' });
  }
  if (doc.expires_at === null) {
    return res.status(400).json({ error: 'This report has no expiry — it is permanent.' });
  }

  const ttlSecs = TTL[doc.type as string] ?? 60 * 60 * 24 * 4;
  if (ttlSecs === null) {
    return res.status(400).json({ error: 'Permanent report cannot be extended.' });
  }

  // Extend from now + original TTL
  const newExpiry = new Date(Date.now() + ttlSecs * 1000);

  await col.updateOne({ _id: req.params.id as any }, {
    $set: {
      expires_at:           newExpiry,
      expiry_warning_sent:  false,  // reset so trigger can warn again
      extended_at:          new Date(),
    },
  });

  return res.json({
    message:    'Report extended successfully',
    expires_at: newExpiry,
    ttl_days:   Math.round(ttlSecs / (60 * 60 * 24)),
  });
});

// ─── POST /reports/trigger/expiry-warning ─────────────────────────────────────
// Called by MongoDB Atlas Trigger — sends push warning 24h before expiry.
// The trigger only needs to send report_id — we look up device_id ourselves.
// Protected by TRIGGER_SECRET header.
router.post('/trigger/expiry-warning', async (req: Request, res: Response) => {
  const secret = req.headers['x-trigger-secret'] as string;
  if (!secret || secret !== process.env.TRIGGER_SECRET) {
    return res.status(403).json({ error: 'Trigger secret required.' });
  }

  const { report_id } = req.body;
  if (!report_id) {
    return res.status(400).json({ error: 'report_id is required.' });
  }

  const col = getCollection('reports');
  const doc = await col.findOne({ _id: report_id as any });

  if (!doc || !doc.is_active) {
    return res.status(404).json({ error: 'Report not found or inactive.' });
  }

  if (doc.expiry_warning_sent) {
    return res.json({ message: 'Warning already sent — skipping.', report_id });
  }

  // Mark warning as sent before pushing to avoid duplicates on retry
  await col.updateOne({ _id: report_id as any }, { $set: { expiry_warning_sent: true } });

  const deviceId   = doc.device_id as string;
  const reportType = (doc.type as string).replace(/_/g, ' ');
  const expiresAt  = doc.expires_at ? new Date(doc.expires_at).toLocaleDateString('es-CO', { day: 'numeric', month: 'long' }) : '';

  const axios = (await import('axios')).default;

  try {
    await axios.post('https://api.onesignal.com/notifications?c=push', {
      app_id:          process.env.ONESIGNAL_APP_ID!,
      include_aliases: { external_id: [deviceId] },
      target_channel:  'push',
      headings: { en: '⚠️ Tu reporte vence pronto' },
      contents: { en: `Tu reporte "${reportType}" vence el ${expiresAt}. Ábrelo para extenderlo y mantenerlo activo.` },
      data: {
        action:    'extend_report',
        report_id,
        type:      doc.type,
        expires_at: doc.expires_at,
      },
      priority: 8,
      ios_interruption_level: 'time_sensitive',
    }, {
      headers: {
        'Content-Type': 'application/json',
        Authorization:  `Key ${process.env.ONESIGNAL_API_KEY!}`,
      },
    });

    console.log(`[Trigger] Expiry warning sent → device=${deviceId} report=${report_id}`);
    return res.json({ message: 'Expiry warning sent', report_id, device_id: deviceId });

  } catch (err: any) {
    // Rollback warning flag so trigger can retry
    await col.updateOne({ _id: report_id as any }, { $set: { expiry_warning_sent: false } });
    console.error('[Trigger] Push failed:', err?.response?.data || err.message);
    return res.status(500).json({ error: 'Push notification failed' });
  }
});

// ─── DELETE /reports/:id ──────────────────────────────────────────────────────
router.delete('/:id', authMiddleware, async (req: Request, res: Response) => {
  const col = getCollection('reports');
  const doc = await col.findOne({ _id: req.params.id as any });
  if (!doc) return res.status(404).json({ error: 'Report not found or expired' });
  if (doc.device_id !== (req as any).deviceId) return res.status(403).json({ error: 'You can only delete your own reports' });

  await col.updateOne({ _id: req.params.id as any }, { $set: { is_active: false, deactivated_at: new Date() } });
  return res.json({ message: 'Report deactivated' });
});

export default router;
