import { timingSafeEqual } from 'crypto';
import type { Request, Response, NextFunction } from 'express';

function configuredToken(): string | undefined {
  return process.env.API_AUTH_TOKEN?.trim() || undefined;
}

export function isApiAuthEnabled(): boolean {
  return !!configuredToken();
}

export function isTokenAuthorized(candidate?: string): boolean {
  const expected = configuredToken();
  if (!expected) return true;
  if (!candidate) return false;

  const expectedBuffer = Buffer.from(expected);
  const candidateBuffer = Buffer.from(candidate);
  if (expectedBuffer.length !== candidateBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, candidateBuffer);
}

export function tokenFromAuthorizationHeader(header?: string): string | undefined {
  if (!header) return undefined;
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return undefined;
  return token;
}

export function createApiAuthMiddleware(options?: { publicPaths?: string[] }) {
  const publicPaths = new Set(options?.publicPaths || []);

  return (req: Request, res: Response, next: NextFunction) => {
    if (!isApiAuthEnabled()) return next();
    if (req.method === 'OPTIONS') return next();
    if (publicPaths.has(req.path)) return next();

    const token = tokenFromAuthorizationHeader(req.header('authorization'));
    if (!token) {
      return res.status(401).json({
        error: {
          code: 'AUTH_REQUIRED',
          message: 'Authorization header with Bearer token is required',
        },
      });
    }
    if (!isTokenAuthorized(token)) {
      return res.status(401).json({
        error: {
          code: 'AUTH_INVALID',
          message: 'Authorization token is invalid',
        },
      });
    }

    return next();
  };
}
