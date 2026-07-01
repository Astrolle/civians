import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { getCollection } from '../services/db';
import { authMiddleware } from '../middleware/auth';
import { apiKeyMiddleware } from '../middleware/apiKey';

const router = Router();

// ─── Schema ───────────────────────────────────────────────────────────────────

const SUPPLY_TYPES = [
  'insumos_no_perecederos',
  'insumos_medicos',
  'transporte',
  'voluntarios_logistica',
  'voluntarios_medicos',
  'otros_insumos',
] as const;

export type SupplyType = typeof SUPPLY_TYPES[number];

const NeedsSchema = z.object({
  insumos_no_perecederos: z.boolean().optional().default(false),
  insumos_medicos:        z.boolean().optional().default(false),
  transporte:             z.boolean().optional().default(false),
  voluntarios_logistica:  z.boolean().optional().default(false),
  voluntarios_medicos:    z.boolean().optional().default(false),
  otros_insumos:          z.boolean().optional().default(false),
  // What's most needed right now — free text
  priority_note: z.string().max(300).optional(),
});

const LocationSchema = z.object({
  coordinates: z.tuple([z.number(), z.number()], {
    errorMap: () => ({ message: 'coordinates [longitude, latitude] are required' }),
  }),
  name:         z.string().min(1),
  neighborhood: z.string().max(100).optional(),
  city:         z.string().max(100).optional(),
  address:      z.string().max(200).optional(),
});

const CenterSchema = z.object({
  name:        z.string().min(1, 'Center name is required'),
  description: z.string().max(500).optional(),
  location:    LocationSchema,

  // Capacity status 0–100%: 0 = empty, 50 = sufficient, 100 = collapsed
  collapse_pct: z.number().min(0).max(100),

  // What they need
  needs: NeedsSchema,

  // Responsible person
  responsible_name:  z.string().min(1, 'Responsible name is required'),
  responsible_phone: z.string().min(7, 'Phone is required'),
  responsible_email: z.string().email('Valid email required').optional(),

  // Official donation link
  donation_url: z.string().url().optional(),

  // Optional media
  media: z.array(z.string().url()).optional(),
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function collapseLabel(pct: number): string {
  if (pct <= 30) return 'empty';        // Vacío — necesita todo
  if (pct <= 70) return 'sufficient';   // Con insumos suficientes
  return 'collapsed';                   // Colapsado
}

function calcDistKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R  = 6371;
  const dL = ((lat2 - lat1) * Math.PI) / 180;
  const dl = ((lng2 - lng1) * Math.PI) / 180;
  const a  = Math.sin(dL / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dl / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 100) / 100;
}

function formatDoc(doc: any, lat?: number, lng?: number) {
  if (!doc) return null;
  const coordinates = doc.location?.coordinates ?? [];
  const out: any = {
    ...doc,
    _id:            undefined,
    id:             doc._id,
    collapse_label: collapseLabel(doc.collapse_pct ?? 0),
    coordinates,
  };
  if (lat !== undefined && lng !== undefined && coordinates.length === 2) {
    out.dist_km = calcDistKm(lat, lng, coordinates[1], coordinates[0]);
  }
  return out;
}

// ─── POST /collection-centers ─────────────────────────────────────────────────
router.post('/', authMiddleware, async (req: Request, res: Response) => {
  const parse = CenterSchema.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: parse.error.flatten().fieldErrors });

  const id  = uuidv4();
  const now = new Date();
  const [lng, lat] = parse.data.location.coordinates;

  const doc = {
    _id:        id,
    ...parse.data,
    location: {
      ...parse.data.location,
      geo: { type: 'Point', coordinates: [lng, lat] },
    },
    created_by: (req as any).deviceId,
    created_at: now,
    updated_at: now,
    is_active:  true,
  };

  await getCollection('collection_centers').insertOne(doc as any);

  return res.status(201).json({ message: 'Collection center created', center: formatDoc(doc) });
});

// ─── GET /collection-centers — by proximity ───────────────────────────────────
router.get('/', authMiddleware, async (req: Request, res: Response) => {
  const lat    = parseFloat(req.query.latitude  as string);
  const lng    = parseFloat(req.query.longitude as string);
  const radius = parseFloat(req.query.radius    as string) || 50; // 50km default

  if (isNaN(lat) || isNaN(lng)) {
    return res.status(400).json({ error: 'latitude and longitude are required.' });
  }

  const filter: any = {
    is_active:     true,
    'location.geo': {
      $near: {
        $geometry:    { type: 'Point', coordinates: [lng, lat] },
        $maxDistance: radius * 1000,
      },
    },
  };

  const docs = await getCollection('collection_centers').find(filter).limit(100).toArray();
  const centers = docs.map((doc: any) => formatDoc(doc, lat, lng));

  return res.json({ centers, total: centers.length, radius_km: radius });
});

// ─── GET /collection-centers/nearby — within 5km like reports ───────────────
router.get('/nearby', authMiddleware, async (req: Request, res: Response) => {
  const lat    = parseFloat(req.query.latitude  as string);
  const lng    = parseFloat(req.query.longitude as string);
  const radius = parseFloat(req.query.radius    as string) || 5; // 5km like reports

  if (isNaN(lat) || isNaN(lng)) {
    return res.status(400).json({ error: 'latitude and longitude are required.', example: '/collection-centers/nearby?latitude=6.2442&longitude=-75.5812' });
  }

  const docs = await getCollection('collection_centers').find({
    is_active: true,
    'location.geo': {
      $near: {
        $geometry:    { type: 'Point', coordinates: [lng, lat] },
        $maxDistance: radius * 1000,
      },
    },
  }).limit(100).toArray();

  const centers = docs.map((doc: any) => formatDoc(doc, lat, lng));

  return res.json({ centers, total: centers.length, radius_km: radius });
});

// ─── GET /collection-centers/search — filter by name/city/neighborhood ──────
// Powers the search bar in the app. Independent of proximity: searches across
// all active centers by text, optionally still sorted by distance if lat/lng
// are provided (e.g. searching while "Cerca de mí" is active).
router.get('/search', authMiddleware, async (req: Request, res: Response) => {
  const q = (req.query.q as string || '').trim();
  if (!q) {
    return res.status(400).json({ error: 'q (search text) is required.' });
  }

  const lat = parseFloat(req.query.latitude  as string);
  const lng = parseFloat(req.query.longitude as string);
  const hasCoords = !isNaN(lat) && !isNaN(lng);

  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(escaped, 'i');

  const filter: any = {
    is_active: true,
    $or: [
      { name:                regex },
      { 'location.name':         regex },
      { 'location.city':         regex },
      { 'location.neighborhood': regex },
      { 'location.address':      regex },
    ],
  };

  const docs = await getCollection('collection_centers').find(filter).limit(100).toArray();
  let centers = docs.map((doc: any) => formatDoc(doc, hasCoords ? lat : undefined, hasCoords ? lng : undefined));

  if (hasCoords) {
    centers = centers.sort((a: any, b: any) => (a.dist_km ?? Infinity) - (b.dist_km ?? Infinity));
  }

  return res.json({ centers, total: centers.length, query: q });
});

// ─── GET /collection-centers/map — all active for map pins ───────────────────
router.get('/map', authMiddleware, async (req: Request, res: Response) => {
  const docs = await getCollection('collection_centers').find(
    { is_active: true },
    { projection: { _id: 1, name: 1, location: 1, collapse_pct: 1, needs: 1 } }
  ).limit(500).toArray();

  const centers = docs.map((doc: any) => ({
    id:             doc._id,
    name:           doc.name,
    coordinates:    doc.location.coordinates,
    collapse_pct:   doc.collapse_pct,
    collapse_label: collapseLabel(doc.collapse_pct),
    needs:          doc.needs,
  }));

  return res.json({ centers, total: centers.length });
});

// ─── GET /collection-centers/public/map — no auth, for the public web view ──
// Powers the /centrosdeacopio page. Deliberately unauthenticated: collection
// center locations and saturation status are public-interest information,
// same data already shown in the app's /map endpoint, just reachable from a
// browser that has no device_id.
router.get('/public/map', async (_req: Request, res: Response) => {
  const docs = await getCollection('collection_centers').find(
    { is_active: true },
    { projection: { _id: 1, name: 1, location: 1, collapse_pct: 1, needs: 1, city: 1 } }
  ).limit(1000).toArray();

  const centers = docs.map((doc: any) => ({
    id:             doc._id,
    name:           doc.name,
    coordinates:    doc.location.coordinates,
    city:           doc.location.city,
    collapse_pct:   doc.collapse_pct,
    collapse_label: collapseLabel(doc.collapse_pct),
    needs:          doc.needs,
  }));

  return res.json({ centers, total: centers.length });
});

// ─── GET /collection-centers/external — for partner apps, requires x-api-key ─
// Meant for other organizations/apps (e.g. Yumi) to sync collection-center
// data programmatically. Requires a private API key in the `x-api-key`
// header (see COLLECTION_CENTERS_API_KEY env var) instead of device auth,
// since external apps don't have a Civians device_id.
router.get('/external', apiKeyMiddleware, async (req: Request, res: Response) => {
  const updatedSince = req.query.updated_since as string | undefined;

  const filter: any = { is_active: true };
  if (updatedSince) {
    const since = new Date(updatedSince);
    if (!isNaN(since.getTime())) {
      filter.updated_at = { $gte: since };
    }
  }

  const docs = await getCollection('collection_centers').find(filter).limit(1000).toArray();
  const centers = docs.map((doc: any) => formatDoc(doc));

  return res.json({ centers, total: centers.length });
});

// ─── GET /collection-centers/:id ─────────────────────────────────────────────
router.get('/:id', authMiddleware, async (req: Request, res: Response) => {
  const doc = await getCollection('collection_centers').findOne({ _id: req.params.id as any });
  if (!doc) return res.status(404).json({ error: 'Collection center not found' });
  return res.json({ center: formatDoc(doc) });
});

// ─── PATCH /collection-centers/:id ───────────────────────────────────────────
// Any authenticated user can edit — collection centers are community-maintained,
// not owned by their creator. We keep created_by as historical record and add
// last_edited_by/last_edited_at as an audit trail of the most recent editor.
router.patch('/:id', authMiddleware, async (req: Request, res: Response) => {
  const col = getCollection('collection_centers');
  const doc = await col.findOne({ _id: req.params.id as any });
  if (!doc) return res.status(404).json({ error: 'Collection center not found' });

  const parse = CenterSchema.partial().safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: parse.error.flatten().fieldErrors });

  const now = new Date();
  const update: any = {
    ...parse.data,
    updated_at:      now,
    last_edited_by:  (req as any).deviceId,
    last_edited_at:  now,
  };
  if (parse.data.location) {
    const [lng, lat] = parse.data.location.coordinates as [number, number];
    update['location.geo'] = { type: 'Point', coordinates: [lng, lat] };
  }

  await col.updateOne({ _id: req.params.id as any }, { $set: update });
  const updated = await col.findOne({ _id: req.params.id as any });
  if (!updated) return res.status(404).json({ error: 'Collection center not found after update' });
  return res.json({ message: 'Collection center updated', center: formatDoc(updated) });
});

// ─── PATCH /collection-centers/:id/collapse — quick update of collapse % ─────
// Any authenticated user can report saturation — this is the field most likely
// to go stale, so letting anyone update it keeps the data current.
router.patch('/:id/collapse', authMiddleware, async (req: Request, res: Response) => {
  const col = getCollection('collection_centers');
  const doc = await col.findOne({ _id: req.params.id as any });
  if (!doc) return res.status(404).json({ error: 'Collection center not found' });

  const parse = z.object({ collapse_pct: z.number().min(0).max(100) }).safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: parse.error.flatten().fieldErrors });

  const now = new Date();
  await col.updateOne({ _id: req.params.id as any }, {
    $set: {
      collapse_pct:   parse.data.collapse_pct,
      updated_at:     now,
      last_edited_by: (req as any).deviceId,
      last_edited_at: now,
    },
  });

  return res.json({
    message:        'Collapse status updated',
    collapse_pct:   parse.data.collapse_pct,
    collapse_label: collapseLabel(parse.data.collapse_pct),
  });
});

// ─── DELETE /collection-centers/:id ──────────────────────────────────────────
router.delete('/:id', authMiddleware, async (req: Request, res: Response) => {
  const col = getCollection('collection_centers');
  const doc = await col.findOne({ _id: req.params.id as any });
  if (!doc) return res.status(404).json({ error: 'Collection center not found' });
  if (doc.created_by !== (req as any).deviceId) {
    return res.status(403).json({ error: 'You can only delete your own collection centers.' });
  }

  await col.updateOne({ _id: req.params.id as any }, { $set: { is_active: false, deactivated_at: new Date() } });
  return res.json({ message: 'Collection center deactivated' });
});

export default router;
