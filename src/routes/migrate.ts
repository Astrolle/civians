// Endpoint temporal de migración — úsalo UNA vez y luego elimínalo
// GET /admin/migrate
import { Router } from 'express';
import { getWriteDB } from '../services/db';

const router = Router();

router.get('/migrate', async (req, res) => {
  const secret = req.headers['x-admin-secret'] as string;
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Admin access required.' });
  }

  const db = getWriteDB();
  const results: string[] = [];

  const migrations = [
    "ALTER TABLE profiles ADD COLUMN search_radius_km REAL NOT NULL DEFAULT 5",
    "ALTER TABLE profiles ADD COLUMN is_official INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE profiles ADD COLUMN official_org TEXT",
    "ALTER TABLE profiles ADD COLUMN official_role TEXT",
  ];

  for (const sql of migrations) {
    try {
      await db.execute(sql);
      results.push(`✅ ${sql}`);
    } catch (err: any) {
      // Column already exists — not an error
      results.push(`⚠️ ${sql} → ${err.message}`);
    }
  }

  return res.json({ message: 'Migration complete', results });
});

export default router;
