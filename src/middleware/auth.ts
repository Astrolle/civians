import { Request, Response, NextFunction } from 'express';
import { getReadDB } from '../services/db';

export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const apiKey = (req.headers['x-api-key'] as string)
    || req.headers['authorization']?.replace('Bearer ', '');

  if (!apiKey) {
    return res.status(401).json({ error: 'API key required. Use X-Api-Key header.' });
  }

  const result = await getReadDB().execute({
    sql: 'SELECT * FROM profiles WHERE device_id = ?',
    args: [apiKey],
  });

  if (result.rows.length === 0) {
    return res.status(401).json({ error: 'Invalid API key. Register your device first.' });
  }

  (req as any).deviceId = apiKey;
  (req as any).profile = result.rows[0];
  next();
}
