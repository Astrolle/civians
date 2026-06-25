import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { getWriteDB, getReadDB } from '../services/db';
import { authMiddleware } from '../middleware/auth';

const router = Router();

const ProfileSchema = z.object({
  device_id: z.string().min(1, 'device_id is required'),
  name:      z.string().min(1, 'name is required'),
  phone:     z.string().min(7, 'phone is required'),
  city:      z.string().max(100).optional(),
  country:   z.string().max(100).optional(),
});

const LocationSchema = z.object({
  latitude:  z.number({ required_error: 'latitude is required' }),
  longitude: z.number({ required_error: 'longitude is required' }),
});

// POST /profile - Register device
router.post('/', async (req: Request, res: Response) => {
  const parse = ProfileSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: parse.error.flatten().fieldErrors });
  }

  const { device_id, name, phone, city, country } = parse.data;
  const now = new Date().toISOString();

  await getWriteDB().execute({
    sql: `
      INSERT INTO profiles (device_id, name, phone, city, country, registered_at)
      VALUES (:device_id, :name, :phone, :city, :country, :registered_at)
      ON CONFLICT(device_id) DO UPDATE SET
        name       = excluded.name,
        phone      = excluded.phone,
        city       = excluded.city,
        country    = excluded.country,
        updated_at = :registered_at
    `,
    args: { device_id, name, phone, city: city ?? null, country: country ?? null, registered_at: now },
  });

  return res.status(201).json({
    message: 'Profile registered. Your API key is your device_id.',
    api_key: device_id,
    profile: { device_id, name, phone, city: city ?? null, country: country ?? null, registered_at: now },
  });
});

// GET /profile/me
router.get('/me', authMiddleware, (req: Request, res: Response) => {
  return res.json({ profile: (req as any).profile });
});

// PUT /profile/me - Update general profile fields
router.put('/me', authMiddleware, async (req: Request, res: Response) => {
  const deviceId = (req as any).deviceId as string;

  const UpdateSchema = z.object({
    name:  z.string().min(1).optional(),
    phone: z.string().min(7).optional(),
  });

  const parse = UpdateSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: parse.error.flatten().fieldErrors });
  }

  const { name, phone } = parse.data;
  const now = new Date().toISOString();

  const fields: string[] = ['updated_at = :updated_at'];
  const args: Record<string, string> = { device_id: deviceId, updated_at: now };

  if (name)  { fields.push('name = :name');   args.name = name; }
  if (phone) { fields.push('phone = :phone'); args.phone = phone; }

  await getWriteDB().execute({
    sql: `UPDATE profiles SET ${fields.join(', ')} WHERE device_id = :device_id`,
    args,
  });

  const result = await getReadDB().execute({
    sql: 'SELECT * FROM profiles WHERE device_id = ?',
    args: [deviceId],
  });

  return res.json({ message: 'Profile updated', profile: result.rows[0] });
});

// PATCH /profile/me/location - Update GPS coordinates when user moves
router.patch('/me/location', authMiddleware, async (req: Request, res: Response) => {
  const deviceId = (req as any).deviceId as string;

  const parse = LocationSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: parse.error.flatten().fieldErrors });
  }

  const { latitude, longitude } = parse.data;
  const now = new Date().toISOString();

  await getWriteDB().execute({
    sql: `UPDATE profiles SET latitude = :latitude, longitude = :longitude, updated_at = :updated_at WHERE device_id = :device_id`,
    args: { latitude, longitude, updated_at: now, device_id: deviceId },
  });

  return res.json({ message: 'Location updated', location: { latitude, longitude } });
});

export default router;
