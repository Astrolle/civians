import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import redis from '../services/redis';
import { GeoReplyWith } from 'redis';
import { authMiddleware } from '../middleware/auth';
import { sendPushToNearbyUsers } from '../services/onesignal';

const router = Router();

const GEO_KEY_OFFICIAL   = 'notifications:official:geo';
const GEO_KEY_UNOFFICIAL = 'notifications:unofficial:geo';

const TTL_OFFICIAL   = 60 * 60 * 24 * 7;  // 7 días
const TTL_UNOFFICIAL = 60 * 60 * 24 * 3;  // 3 días

// --- Schemas ---

const LocationSchema = z.object({
  coordinates:  z.tuple([z.number(), z.number()], {
    errorMap: () => ({ message: 'coordinates [longitude, latitude] are required' }),
  }),
  name:         z.string().min(1, 'location name is required'),
  neighborhood: z.string().max(100).optional(),
  city:         z.string().max(100).optional(),
});

const OfficialNotificationSchema = z.object({
  title:           z.string().min(1, 'title is required'),
  description:     z.string().min(1, 'description is required'),
  event_type:      z.string().min(1, 'event_type is required'),
  severity:        z.enum(['info', 'warning', 'critical']).default('warning'),
  location:        LocationSchema,
  position:        z.string().optional(),
  characteristics: z.record(z.string(), z.any()).optional(),
  issued_by:       z.string().optional(),
  media:           z.array(z.string().url()).optional(),
});

const UnofficialNotificationSchema = z.object({
  title:       z.string().min(1, 'title is required'),
  description: z.string().min(1, 'description is required'),
  event_type:  z.string().min(1, 'event_type is required'),
  severity:    z.enum(['info', 'warning', 'critical']).default('warning'),
  location:    LocationSchema,
  media:       z.array(z.string().url()).optional(),
});

// --- Helpers ---

async function enrichWithConfirmations(notification: any, deviceId: string) {
  const confirmations   = await redis.sCard(`notification:${notification.id}:confirms`);
  const confirmed_by_me = await redis.sIsMember(`notification:${notification.id}:confirms`, deviceId);
  return { ...notification, confirmations, confirmed_by_me };
}

// ─────────────────────────────────────────
// OFFICIAL NOTIFICATIONS
// ─────────────────────────────────────────

// POST /notifications/official
router.post('/official', authMiddleware, async (req: Request, res: Response) => {
  const parse = OfficialNotificationSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: parse.error.flatten().fieldErrors });
  }

  const id    = uuidv4();
  const now   = new Date().toISOString();
  const score = Date.now();

  const notification = {
    id,
    kind: 'official',
    ...parse.data,
    created_at: now,
    created_by: (req as any).deviceId,
    is_active:  true,
  };

  await redis.set(`notification:${id}`, JSON.stringify(notification), { EX: TTL_OFFICIAL });
  await redis.geoAdd(GEO_KEY_OFFICIAL, { longitude: notification.location.coordinates[0] as number, latitude: notification.location.coordinates[1] as number, member: id });
  await redis.zAdd('notifications:official',                              { score, value: id });
  await redis.zAdd(`notifications:official:type:${notification.event_type}`, { score, value: id });
  await redis.zAdd(`notifications:official:severity:${notification.severity}`, { score, value: id });

  // Push to all users within 5km — fire and forget
  sendPushToNearbyUsers(notification.location.coordinates as [number, number], {
    title: `🚨 ${notification.title}`,
    body: notification.description,
    data: { notification_id: id, kind: 'official', event_type: notification.event_type },
  }, (req as any).deviceId).catch((err) => console.error('[Push] Official notification push failed:', err));

  return res.status(201).json({ message: 'Official notification created', notification });
});

// GET /notifications/official
router.get('/official', authMiddleware, async (req: Request, res: Response) => {
  const limit      = parseInt(req.query.limit  as string) || 20;
  const offset     = parseInt(req.query.offset as string) || 0;
  const event_type = req.query.event_type as string | undefined;
  const severity   = req.query.severity   as string | undefined;

  let setKey = 'notifications:official';
  if (event_type) setKey = `notifications:official:type:${event_type}`;
  if (severity)   setKey = `notifications:official:severity:${severity}`;

  const ids   = (await redis.zRange(setKey, offset, offset + limit - 1, { REV: true })) as string[];
  const total = await redis.zCard(setKey);

  if (!ids.length) return res.json({ notifications: [], total: 0 });

  const raws = await Promise.all(ids.map((id) => redis.get(`notification:${id}`)));
  const notifications = await Promise.all(
    raws
      .filter(Boolean)
      .map((n) => JSON.parse(n!))
      .filter((n) => n.is_active)
      .map((n) => enrichWithConfirmations(n, (req as any).deviceId))
  );

  return res.json({ notifications, total, limit, offset });
});

// ─────────────────────────────────────────
// UNOFFICIAL NOTIFICATIONS
// ─────────────────────────────────────────

// POST /notifications/unofficial
router.post('/unofficial', authMiddleware, async (req: Request, res: Response) => {
  const parse = UnofficialNotificationSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: parse.error.flatten().fieldErrors });
  }

  const id    = uuidv4();
  const now   = new Date().toISOString();
  const score = Date.now();

  const notification = {
    id,
    kind: 'unofficial',
    ...parse.data,
    created_at: now,
    created_by: (req as any).deviceId,
    is_active:  true,
  };

  await redis.set(`notification:${id}`, JSON.stringify(notification), { EX: TTL_UNOFFICIAL });
  await redis.geoAdd(GEO_KEY_UNOFFICIAL, { longitude: notification.location.coordinates[0] as number, latitude: notification.location.coordinates[1] as number, member: id });
  await redis.zAdd('notifications:unofficial',                                { score, value: id });
  await redis.zAdd(`notifications:unofficial:type:${notification.event_type}`, { score, value: id });
  await redis.zAdd(`notifications:unofficial:severity:${notification.severity}`, { score, value: id });

  // Push to all users within 5km — fire and forget
  sendPushToNearbyUsers(notification.location.coordinates as [number, number], {
    title: `⚠️ ${notification.title}`,
    body: notification.description,
    data: { notification_id: id, kind: 'unofficial', event_type: notification.event_type },
  }, (req as any).deviceId).catch((err) => console.error('[Push] Unofficial notification push failed:', err));

  return res.status(201).json({ message: 'Unofficial notification created', notification });
});

// GET /notifications/unofficial
router.get('/unofficial', authMiddleware, async (req: Request, res: Response) => {
  const limit      = parseInt(req.query.limit  as string) || 20;
  const offset     = parseInt(req.query.offset as string) || 0;
  const event_type = req.query.event_type as string | undefined;
  const severity   = req.query.severity   as string | undefined;

  let setKey = 'notifications:unofficial';
  if (event_type) setKey = `notifications:unofficial:type:${event_type}`;
  if (severity)   setKey = `notifications:unofficial:severity:${severity}`;

  const ids   = (await redis.zRange(setKey, offset, offset + limit - 1, { REV: true })) as string[];
  const total = await redis.zCard(setKey);

  if (!ids.length) return res.json({ notifications: [], total: 0 });

  const raws = await Promise.all(ids.map((id) => redis.get(`notification:${id}`)));
  const notifications = await Promise.all(
    raws
      .filter(Boolean)
      .map((n) => JSON.parse(n!))
      .filter((n) => n.is_active)
      .map((n) => enrichWithConfirmations(n, (req as any).deviceId))
  );

  return res.json({ notifications, total, limit, offset });
});

// ─────────────────────────────────────────
// GET /notifications/official/nearby — sorted by proximity with distance
router.get('/official/nearby', authMiddleware, async (req: Request, res: Response) => {
  const lat = parseFloat(req.query.latitude  as string);
  const lng = parseFloat(req.query.longitude as string);
  const radius = parseFloat(req.query.radius as string) || 5;

  if (isNaN(lat) || isNaN(lng)) {
    return res.status(400).json({ error: 'latitude and longitude are required.', example: '/notifications/official/nearby?latitude=6.2442&longitude=-75.5812' });
  }

  const results = await redis.geoSearchWith(
    GEO_KEY_OFFICIAL,
    { longitude: lng, latitude: lat },
    { radius, unit: 'km' },
    [GeoReplyWith.DISTANCE],
    { COUNT: 100, SORT: 'ASC' }
  );

  if (!results.length) return res.json({ notifications: [], total: 0, radius_km: radius });

  const distanceMap = new Map<string, number>();
  results.forEach((r) => distanceMap.set(r.member, parseFloat((r.distance ?? '0').toString())));

  const raws = await Promise.all(results.map((r) => redis.get(`notification:${r.member}`)));
  const notifications = await Promise.all(
    raws.filter(Boolean).map((n) => JSON.parse(n!)).filter((n) => n.is_active)
      .map(async (n) => {
        const confirmations   = await redis.sCard(`notification:${n.id}:confirms`);
        const confirmed_by_me = await redis.sIsMember(`notification:${n.id}:confirms`, (req as any).deviceId);
        return { ...n, confirmations, confirmed_by_me, dist_km: distanceMap.get(n.id) ?? null };
      })
  );

  return res.json({ notifications, total: notifications.length, radius_km: radius });
});

// GET /notifications/unofficial/nearby — sorted by proximity with distance
router.get('/unofficial/nearby', authMiddleware, async (req: Request, res: Response) => {
  const lat = parseFloat(req.query.latitude  as string);
  const lng = parseFloat(req.query.longitude as string);
  const radius = parseFloat(req.query.radius as string) || 5;

  if (isNaN(lat) || isNaN(lng)) {
    return res.status(400).json({ error: 'latitude and longitude are required.', example: '/notifications/unofficial/nearby?latitude=6.2442&longitude=-75.5812' });
  }

  const results = await redis.geoSearchWith(
    GEO_KEY_UNOFFICIAL,
    { longitude: lng, latitude: lat },
    { radius, unit: 'km' },
    [GeoReplyWith.DISTANCE],
    { COUNT: 100, SORT: 'ASC' }
  );

  if (!results.length) return res.json({ notifications: [], total: 0, radius_km: radius });

  const distanceMap = new Map<string, number>();
  results.forEach((r) => distanceMap.set(r.member, parseFloat((r.distance ?? '0').toString())));

  const raws = await Promise.all(results.map((r) => redis.get(`notification:${r.member}`)));
  const notifications = await Promise.all(
    raws.filter(Boolean).map((n) => JSON.parse(n!)).filter((n) => n.is_active)
      .map(async (n) => {
        const confirmations   = await redis.sCard(`notification:${n.id}:confirms`);
        const confirmed_by_me = await redis.sIsMember(`notification:${n.id}:confirms`, (req as any).deviceId);
        return { ...n, confirmations, confirmed_by_me, dist_km: distanceMap.get(n.id) ?? null };
      })
  );

  return res.json({ notifications, total: notifications.length, radius_km: radius });
});

// GET /notifications/map — all active notifications with coordinates for map rendering
router.get('/map', authMiddleware, async (req: Request, res: Response) => {
  const kind = req.query.kind as string | undefined; // 'official' | 'unofficial' | undefined (both)

  const sets: string[] = [];
  if (!kind || kind === 'official')   sets.push('notifications:official');
  if (!kind || kind === 'unofficial') sets.push('notifications:unofficial');

  const allIds = new Set<string>();
  for (const setKey of sets) {
    const ids = (await redis.zRange(setKey, 0, -1, { REV: true })) as string[];
    ids.forEach((id) => allIds.add(id));
  }

  if (!allIds.size) return res.json({ notifications: [] });

  const raws = await Promise.all([...allIds].map((id) => redis.get(`notification:${id}`)));

  const notifications = raws
    .filter(Boolean)
    .map((n) => JSON.parse(n!))
    .filter((n) => n.is_active)
    .map((n) => ({
      id:          n.id,
      kind:        n.kind,
      title:       n.title,
      event_type:  n.event_type,
      severity:    n.severity,
      coordinates: n.location.coordinates,  // [lng, lat] ready for map pin
      location:    n.location,
      created_at:  n.created_at,
      created_by:  n.created_by,
    }));

  return res.json({ notifications, total: notifications.length });
});

// SHARED: single GET, PATCH, DELETE, confirm
// ─────────────────────────────────────────

// GET /notifications/:id
router.get('/:id', authMiddleware, async (req: Request, res: Response) => {
  const { id } = req.params;
  const raw = await redis.get(`notification:${id}`);
  if (!raw) return res.status(404).json({ error: 'Notification not found or expired' });

  const notification = await enrichWithConfirmations(JSON.parse(raw), (req as any).deviceId);
  return res.json({ notification });
});

// PATCH /notifications/:id
router.patch('/:id', authMiddleware, async (req: Request, res: Response) => {
  const { id } = req.params;
  const raw = await redis.get(`notification:${id}`);
  if (!raw) return res.status(404).json({ error: 'Notification not found or expired' });

  // @ts-ignore
  const existing = JSON.parse(raw);

  if (existing.created_by !== (req as any).deviceId) {
    return res.status(403).json({ error: 'You can only edit your own notifications.' });
  }

  const Schema = existing.kind === 'official'
    ? OfficialNotificationSchema.partial()
    : UnofficialNotificationSchema.partial();

  const parse = Schema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: parse.error.flatten().fieldErrors });
  }

  const updated = {
    ...existing,
    ...parse.data,
    updated_at: new Date().toISOString(),
    updated_by: (req as any).deviceId,
  };

  await redis.set(`notification:${id}`, JSON.stringify(updated), { KEEPTTL: true });
  return res.json({ message: 'Notification updated', notification: updated });
});

// DELETE /notifications/:id
router.delete('/:id', authMiddleware, async (req: Request, res: Response) => {
  const { id } = req.params;
  const raw = await redis.get(`notification:${id}`);
  if (!raw) return res.status(404).json({ error: 'Notification not found or expired' });

  // @ts-ignore
  const existing = JSON.parse(raw);

  if (existing.created_by !== (req as any).deviceId) {
    return res.status(403).json({ error: 'You can only delete your own notifications.' });
  }

  await redis.del(`notification:${id}`);
  await redis.del(`notification:${id}:confirms`);

  const kind = existing.kind as string;
  await redis.zRem(`notifications:${kind}`, id);
  await redis.zRem(`notifications:${kind}:type:${existing.event_type}`, id);
  await redis.zRem(`notifications:${kind}:severity:${existing.severity}`, id);

  return res.json({ message: 'Notification deleted' });
});

// POST /notifications/:id/confirm
router.post('/:id/confirm', authMiddleware, async (req: Request, res: Response) => {
  const { id } = req.params;
  const deviceId = (req as any).deviceId as string;

  const raw = await redis.get(`notification:${id}`);
  if (!raw) return res.status(404).json({ error: 'Notification not found or expired' });

  const alreadyConfirmed = await redis.sIsMember(`notification:${id}:confirms`, deviceId);
  if (alreadyConfirmed) {
    return res.status(409).json({ error: 'You already confirmed this notification.' });
  }

  await redis.sAdd(`notification:${id}:confirms`, deviceId);
  const confirmations = await redis.sCard(`notification:${id}:confirms`);

  const n = JSON.parse(raw);
  const kind = n.kind as string;
  await redis.zAdd(`notifications:${kind}`,                        { score: confirmations, value: id });
  await redis.zAdd(`notifications:${kind}:type:${n.event_type}`,  { score: confirmations, value: id });
  await redis.zAdd(`notifications:${kind}:severity:${n.severity}`,{ score: confirmations, value: id });

  return res.json({ message: 'Notification confirmed', confirmations });
});

// DELETE /notifications/:id/confirm
router.delete('/:id/confirm', authMiddleware, async (req: Request, res: Response) => {
  const { id } = req.params;
  const deviceId = (req as any).deviceId as string;

  const raw = await redis.get(`notification:${id}`);
  if (!raw) return res.status(404).json({ error: 'Notification not found or expired' });

  const wasConfirmed = await redis.sIsMember(`notification:${id}:confirms`, deviceId);
  if (!wasConfirmed) {
    return res.status(409).json({ error: 'You have not confirmed this notification.' });
  }

  await redis.sRem(`notification:${id}:confirms`, deviceId);
  const confirmations = await redis.sCard(`notification:${id}:confirms`);

  const n = JSON.parse(raw);
  const kind = n.kind as string;
  await redis.zAdd(`notifications:${kind}`,                        { score: confirmations, value: id });
  await redis.zAdd(`notifications:${kind}:type:${n.event_type}`,  { score: confirmations, value: id });
  await redis.zAdd(`notifications:${kind}:severity:${n.severity}`,{ score: confirmations, value: id });

  return res.json({ message: 'Confirmation removed', confirmations });
});

export default router;
