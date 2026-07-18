import { createHash, timingSafeEqual } from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { loadConfig } from '../config';

/**
 * Admin authentication. A single strong bearer token gates the entire admin
 * surface. The token is compared in constant time. We never log the token; the
 * audit actor is a short hash of it so actions are attributable without
 * exposing the secret.
 */

function extractToken(req: Request): string | null {
  const auth = req.header('authorization');
  if (auth && auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  const header = req.header('x-admin-token');
  if (header) return header.trim();
  return null;
}

export function actorHash(token: string): string {
  return `admin:${createHash('sha256').update(token).digest('hex').slice(0, 12)}`;
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const cfg = loadConfig();
  const expected = cfg.adminToken;
  if (!expected || expected.length < 16) {
    res.status(503).json({ error: 'admin API disabled: ADMIN_TOKEN not configured' });
    return;
  }
  const provided = extractToken(req);
  if (!provided) {
    res.status(401).json({ error: 'missing admin token' });
    return;
  }
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    res.status(403).json({ error: 'invalid admin token' });
    return;
  }
  (req as Request & { adminActor: string }).adminActor = actorHash(provided);
  next();
}
