import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { getCollection } from '../services/db';
import { authMiddleware, officialOnly } from '../middleware/auth';
import { sendPushToNearbyUsers } from '../services/onesignal';

const router = Router();

const TTL_OFFICIAL   = 60 * 60 * 24 * 5;  // 5 días
const TTL_UNOFFICIAL = 60 * 60 * 24 * 3;  // 3 días

const LocationSchema = z.object({
  coordinates: z.tuple([z.number(), z.number()], {
    errorMap: () => ({ message: 'coordinates [longitude, latitude] are required' }),
  }),
  name:         z.string().min(1, 'location name is required'),
  neighborhood: z.string().max(100).optional(),
  city:         z.string().max(100).optional(),
});

const OfficialSchema = z.object({
  title:           z.string().min(1),
  description:     z.string().min(1),
  event_type:      z.string().min(1),
  severity:        z.enum(['info', 'warning', 'critical']).default('warning'),
  location:        LocationSchema,
  position:        z.string().optional(),
  characteristics: z.record(z.string(), z.any()).optional(),
  issued_by:       z.string().optional(),
  country:         z.string().optional(),  // auto-set from profile if not provided
  media:           z.array(z.string().url()).optional(),
});

const UnofficialSchema = z.object({
  title:       z.string().min(1),
  description: z.string().min(1),
  event_type:  z.string().min(1),
  severity:    z.enum(['info', 'warning', 'critical']).default('warning'),
  location:    LocationSchema,
  media:       z.array(z.string().url()).optional(),
});

function rankingScore(confirmations: number, dist_km: number): number {
  return (confirmations * 10) - dist_km;
}

function toGeoJSON(coordinates: [number, number]) {
  return { type: 'Point', coordinates };
}

// ─── POST /notifications/official ────────────────────────────────────────────
router.post('/official', authMiddleware, officialOnly, async (req: Request, res: Response) => {
  const parse = OfficialSchema.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: parse.error.flatten().fieldErrors });

  const id  = uuidv4();
  const now = new Date();
  const col = getCollection('notifications');
  const [lng, lat] = parse.data.location.coordinates;

  const profile = (req as any).profile;
  const doc = {
    _id:        id,
    kind:       'official',
    ...parse.data,
    country:    parse.data.country || profile.country || null,  // from payload or profile
    location: {
      ...parse.data.location,
      geo: toGeoJSON([lng, lat]),
    },
    confirmations: 0,
    confirmed_by:  [] as string[],
    created_by:    (req as any).deviceId,
    created_at:    now,
    is_active:     true,
    expires_at:    new Date(now.getTime() + TTL_OFFICIAL * 1000),
  };

  await col.insertOne(doc as any);

  sendPushToNearbyUsers([lng, lat], {
    title: `🚨 ${doc.title}`,
    body:  doc.description,
    data:  { notification_id: id, kind: 'official', event_type: doc.event_type },
  }, (req as any).deviceId).catch((err) => console.error('[Push]', err));

  return res.status(201).json({ message: 'Notification created', notification: { ...doc, _id: undefined, id } });
});

// ─── POST /notifications/unofficial ──────────────────────────────────────────
router.post('/unofficial', authMiddleware, async (req: Request, res: Response) => {
  const parse = UnofficialSchema.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: parse.error.flatten().fieldErrors });

  const id  = uuidv4();
  const now = new Date();
  const col = getCollection('notifications');
  const [lng, lat] = parse.data.location.coordinates;

  const doc = {
    _id:        id,
    kind:       'unofficial',
    ...parse.data,
    location: {
      ...parse.data.location,
      geo: toGeoJSON([lng, lat]),
    },
    confirmations: 0,
    confirmed_by:  [] as string[],
    created_by:    (req as any).deviceId,
    created_at:    now,
    is_active:     true,
    expires_at:    new Date(now.getTime() + TTL_UNOFFICIAL * 1000),
  };

  await col.insertOne(doc as any);

  sendPushToNearbyUsers([lng, lat], {
    title: `⚠️ ${doc.title}`,
    body:  doc.description,
    data:  { notification_id: id, kind: 'unofficial', event_type: doc.event_type },
  }, (req as any).deviceId).catch((err) => console.error('[Push]', err));

  return res.status(201).json({ message: 'Notification created', notification: { ...doc, _id: undefined, id } });
});

// ─── GET /notifications/official ─────────────────────────────────────────────
router.get('/official', authMiddleware, async (req: Request, res: Response) => {
  const lat        = parseFloat(req.query.latitude  as string);
  const lng        = parseFloat(req.query.longitude as string);
  const radius     = parseFloat(req.query.radius    as string) || 50;
  const event_type = req.query.event_type as string | undefined;
  const severity   = req.query.severity   as string | undefined;
  const deviceId   = (req as any).deviceId as string;

  if (isNaN(lat) || isNaN(lng)) {
    return res.status(400).json({ error: 'latitude and longitude are required.' });
  }

  const deviceProfile = (req as any).profile;
  const userCountry    = deviceProfile.country || null;

  const filter: any = {
    kind:      'official',
    is_active: true,
    'location.geo': {
      $nearSphere: {
        $geometry:    { type: 'Point', coordinates: [lng, lat] },
        $maxDistance: radius * 1000,
      },
    },
  };

  // Filter by country — only show official notifications from same country
  if (userCountry) filter.country = userCountry;

  if (event_type) filter.event_type = event_type;
  if (severity)   filter.severity   = severity;

  const docs = await getCollection('notifications').find(filter).limit(200).toArray();

  const notifications = docs.map((doc: any) => {
    const dist_km = calcDistKm(lat, lng, doc.location.coordinates[1], doc.location.coordinates[0]);
    const confirmed_by_me = (doc.confirmed_by || []).includes(deviceId);
    return { ...doc, _id: undefined, id: doc._id, dist_km, confirmed_by_me };
  });

  notifications.sort((a, b) => rankingScore(b.confirmations, b.dist_km) - rankingScore(a.confirmations, a.dist_km));

  return res.json({ notifications, total: notifications.length, radius_km: radius });
});

// ─── GET /notifications/unofficial ───────────────────────────────────────────
router.get('/unofficial', authMiddleware, async (req: Request, res: Response) => {
  const lat      = parseFloat(req.query.latitude  as string);
  const lng      = parseFloat(req.query.longitude as string);
  const radius   = parseFloat(req.query.radius    as string) || 50;
  const severity = req.query.severity as string | undefined;
  const deviceId = (req as any).deviceId as string;

  if (isNaN(lat) || isNaN(lng)) {
    return res.status(400).json({ error: 'latitude and longitude are required.' });
  }

  const filter: any = {
    kind: 'unofficial',
    is_active: true,
    'location.geo': {
      $nearSphere: {
        $geometry:    { type: 'Point', coordinates: [lng, lat] },
        $maxDistance: radius * 1000,
      },
    },
  };

  if (severity) filter.severity = severity;

  const docs = await getCollection('notifications').find(filter).limit(200).toArray();

  const notifications = docs.map((doc: any) => {
    const dist_km = calcDistKm(lat, lng, doc.location.coordinates[1], doc.location.coordinates[0]);
    const confirmed_by_me = (doc.confirmed_by || []).includes(deviceId);
    return { ...doc, _id: undefined, id: doc._id, dist_km, confirmed_by_me };
  });

  notifications.sort((a, b) => rankingScore(b.confirmations, b.dist_km) - rankingScore(a.confirmations, a.dist_km));

  return res.json({ notifications, total: notifications.length, radius_km: radius });
});

// ─── GET /notifications/official/nearby ──────────────────────────────────────
router.get('/official/nearby', authMiddleware, async (req: Request, res: Response) => {
  const lat      = parseFloat(req.query.latitude  as string);
  const lng      = parseFloat(req.query.longitude as string);
  const radius   = parseFloat(req.query.radius    as string) || 5;
  const deviceId = (req as any).deviceId as string;

  if (isNaN(lat) || isNaN(lng)) {
    return res.status(400).json({ error: 'latitude and longitude are required.' });
  }

  const userCountryNearby = ((req as any).profile.country) || null;
  const nearbyFilter: any = {
    kind: 'official', is_active: true,
    'location.geo': { $nearSphere: { $geometry: { type: 'Point', coordinates: [lng, lat] }, $maxDistance: radius * 1000 } },
  };
  if (userCountryNearby) nearbyFilter.country = userCountryNearby;

  const docs = await getCollection('notifications').find(nearbyFilter).limit(100).toArray();

  const notifications = docs.map((doc: any) => {
    const dist_km = calcDistKm(lat, lng, doc.location.coordinates[1], doc.location.coordinates[0]);
    return { ...doc, _id: undefined, id: doc._id, dist_km, confirmed_by_me: (doc.confirmed_by || []).includes(deviceId) };
  });

  notifications.sort((a, b) => rankingScore(b.confirmations, b.dist_km) - rankingScore(a.confirmations, a.dist_km));
  return res.json({ notifications, total: notifications.length, radius_km: radius });
});

// ─── GET /notifications/unofficial/nearby ────────────────────────────────────
router.get('/unofficial/nearby', authMiddleware, async (req: Request, res: Response) => {
  const lat      = parseFloat(req.query.latitude  as string);
  const lng      = parseFloat(req.query.longitude as string);
  const radius   = parseFloat(req.query.radius    as string) || 5;
  const deviceId = (req as any).deviceId as string;

  if (isNaN(lat) || isNaN(lng)) {
    return res.status(400).json({ error: 'latitude and longitude are required.' });
  }

  const docs = await getCollection('notifications').find({
    kind: 'unofficial', is_active: true,
    'location.geo': { $nearSphere: { $geometry: { type: 'Point', coordinates: [lng, lat] }, $maxDistance: radius * 1000 } },
  }).limit(100).toArray();

  const notifications = docs.map((doc: any) => {
    const dist_km = calcDistKm(lat, lng, doc.location.coordinates[1], doc.location.coordinates[0]);
    return { ...doc, _id: undefined, id: doc._id, dist_km, confirmed_by_me: (doc.confirmed_by || []).includes(deviceId) };
  });

  notifications.sort((a, b) => rankingScore(b.confirmations, b.dist_km) - rankingScore(a.confirmations, a.dist_km));
  return res.json({ notifications, total: notifications.length, radius_km: radius });
});

// ─── GET /notifications/map ───────────────────────────────────────────────────
router.get('/map', authMiddleware, async (req: Request, res: Response) => {
  const kind = req.query.kind as string | undefined;
  const filter: any = { is_active: true };
  if (kind) filter.kind = kind;

  const docs = await getCollection('notifications').find(filter, {
    projection: { _id: 1, kind: 1, title: 1, event_type: 1, severity: 1, location: 1, created_at: 1, created_by: 1 },
  }).limit(500).toArray();

  const notifications = docs.map((doc: any) => ({
    id:          doc._id,
    kind:        doc.kind,
    title:       doc.title,
    event_type:  doc.event_type,
    severity:    doc.severity,
    coordinates: doc.location.coordinates,
    location:    doc.location,
    created_at:  doc.created_at,
    created_by:  doc.created_by,
  }));

  return res.json({ notifications, total: notifications.length });
});

// ─── GET /notifications/:id ───────────────────────────────────────────────────
router.get('/:id', authMiddleware, async (req: Request, res: Response) => {
  const doc = await getCollection('notifications').findOne({ _id: req.params.id as any });
  if (!doc) return res.status(404).json({ error: 'Notification not found or expired' });
  const deviceId = (req as any).deviceId as string;
  return res.json({ notification: { ...doc, _id: undefined, id: doc._id, confirmed_by_me: (doc.confirmed_by || []).includes(deviceId) } });
});

// ─── PATCH /notifications/:id ─────────────────────────────────────────────────
router.patch('/:id', authMiddleware, async (req: Request, res: Response) => {
  const col = getCollection('notifications');
  const doc = await col.findOne({ _id: req.params.id as any });
  if (!doc) return res.status(404).json({ error: 'Notification not found or expired' });
  if (doc.created_by !== (req as any).deviceId) return res.status(403).json({ error: 'You can only edit your own notifications.' });

  // Only official accounts can edit official notifications
  if (doc.kind === 'official' && !(req as any).profile.is_official) {
    return res.status(403).json({ error: 'Only official accounts can edit official notifications.' });
  }
  const Schema = doc.kind === 'official' ? OfficialSchema.partial() : UnofficialSchema.partial();
  const parse  = Schema.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: parse.error.flatten().fieldErrors });

  const update: any = { ...parse.data, updated_at: new Date(), updated_by: (req as any).deviceId };
  if (parse.data.location) {
    update['location.geo'] = toGeoJSON(parse.data.location.coordinates as [number, number]);
  }

  await col.updateOne({ _id: req.params.id as any }, { $set: update });
  const updated = await col.findOne({ _id: req.params.id as any });
  return res.json({ message: 'Notification updated', notification: { ...updated, _id: undefined, id: updated!._id } });
});

// ─── DELETE /notifications/:id ────────────────────────────────────────────────
router.delete('/:id', authMiddleware, async (req: Request, res: Response) => {
  const col = getCollection('notifications');
  const doc = await col.findOne({ _id: req.params.id as any });
  if (!doc) return res.status(404).json({ error: 'Notification not found or expired' });
  if (doc.created_by !== (req as any).deviceId) return res.status(403).json({ error: 'You can only delete your own notifications.' });

  await col.updateOne({ _id: req.params.id as any }, { $set: { is_active: false, deactivated_at: new Date() } });
  return res.json({ message: 'Notification deleted' });
});

// ─── POST /notifications/:id/confirm ─────────────────────────────────────────
router.post('/:id/confirm', authMiddleware, async (req: Request, res: Response) => {
  const col      = getCollection('notifications');
  const deviceId = (req as any).deviceId as string;
  const doc      = await col.findOne({ _id: req.params.id as any });
  if (!doc) return res.status(404).json({ error: 'Notification not found or expired' });
  if ((doc.confirmed_by || []).includes(deviceId)) return res.status(409).json({ error: 'You already confirmed this notification.' });

  await col.updateOne({ _id: req.params.id as any }, {
    $addToSet: { confirmed_by: deviceId },
    $inc:      { confirmations: 1 },
  });

  return res.json({ message: 'Notification confirmed', confirmations: (doc.confirmations || 0) + 1 });
});

// ─── DELETE /notifications/:id/confirm ───────────────────────────────────────
router.delete('/:id/confirm', authMiddleware, async (req: Request, res: Response) => {
  const col      = getCollection('notifications');
  const deviceId = (req as any).deviceId as string;
  const doc      = await col.findOne({ _id: req.params.id as any });
  if (!doc) return res.status(404).json({ error: 'Notification not found or expired' });
  if (!(doc.confirmed_by || []).includes(deviceId)) return res.status(409).json({ error: 'You have not confirmed this notification.' });

  await col.updateOne({ _id: req.params.id as any }, {
    $pull: { confirmed_by: deviceId } as any,
    $inc:  { confirmations: -1 },
  });

  return res.json({ message: 'Confirmation removed', confirmations: Math.max(0, (doc.confirmations || 1) - 1) });
});

// ─── Haversine helper ─────────────────────────────────────────────────────────
function calcDistKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R  = 6371;
  const dL = ((lat2 - lat1) * Math.PI) / 180;
  const dl = ((lng2 - lng1) * Math.PI) / 180;
  const a  = Math.sin(dL / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dl / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 100) / 100;
}

export default router;
