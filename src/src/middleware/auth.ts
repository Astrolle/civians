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
  (req as any).profile  = result.rows[0];
  next();
}

/**
 * Only allows requests from profiles with is_official = 1.
 * Must be used after authMiddleware.
 */
export function officialOnly(req: Request, res: Response, next: NextFunction) {
  const profile = (req as any).profile;
  if (!profile || !profile.is_official) {
    return res.status(403).json({
      error:   'This action requires an official account.',
      details: 'Contact Civians to verify your organization and get official access.',
    });
  }
  next();
}
