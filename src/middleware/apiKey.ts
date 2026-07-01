import { Request, Response, NextFunction } from 'express';

// ─── External API Key Middleware ───────────────────────────────────────────
// Separate from `authMiddleware` (which authenticates mobile devices via
// device_id). This middleware is for OTHER APPLICATIONS/ORGANIZATIONS that
// want to read Civians data programmatically (e.g. partner orgs like Yumi
// syncing collection-center saturation).
//
// The key is set as an env var, never hardcoded, and never returned in any
// response. Rotate it by changing COLLECTION_CENTERS_API_KEY and redeploying.

export function apiKeyMiddleware(req: Request, res: Response, next: NextFunction) {
  const configuredKey = process.env.COLLECTION_CENTERS_API_KEY;

  if (!configuredKey) {
    // Fail closed: if no key is configured server-side, nobody gets in via
    // this route rather than silently allowing all traffic.
    return res.status(503).json({ error: 'External API access is not configured.' });
  }

  const providedKey = req.header('x-api-key');

  if (!providedKey || providedKey !== configuredKey) {
    return res.status(401).json({ error: 'Invalid or missing API key.' });
  }

  next();
}
