import { timingSafeEqual } from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { validateApiKey, type ApiKey } from './api-keys.js';

export interface ApiAuthContext {
  kind: 'disabled' | 'static-token' | 'api-key';
  userId: string;
  workspaceId: string;
  scopes: string[];
  apiKey?: ApiKey;
}

function configuredToken(): string | undefined {
  return process.env.API_AUTH_TOKEN?.trim() || undefined;
}

function isExplicitlyEnabled(): boolean {
  return ['1', 'true', 'yes'].includes((process.env.API_AUTH_ENABLED || '').toLowerCase());
}

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

export function isApiAuthEnabled(): boolean {
  return isProduction() || !!configuredToken() || isExplicitlyEnabled();
}

export function isTokenAuthorized(candidate?: string): boolean {
  const expected = configuredToken();
  if (!expected) return !isApiAuthEnabled();
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

export function resolveApiAuthContext(token?: string): ApiAuthContext | null {
  if (!isApiAuthEnabled()) {
    return {
      kind: 'disabled',
      userId: 'local-admin',
      workspaceId: 'default',
      scopes: ['admin'],
    };
  }

  if (!token) return null;

  if (configuredToken() && isTokenAuthorized(token)) {
    return {
      kind: 'static-token',
      userId: 'token-admin',
      workspaceId: 'default',
      scopes: ['admin'],
    };
  }

  const apiKey = validateApiKey(token);
  if (!apiKey) return null;

  return {
    kind: 'api-key',
    userId: `api-key:${apiKey.id}`,
    workspaceId: apiKey.workspaceId,
    scopes: apiKey.scopes,
    apiKey,
  };
}

function normalizeScope(scope: string): string {
  return scope.trim().toLowerCase();
}

export function hasApiScope(ctx: ApiAuthContext | undefined, requiredScope?: string): boolean {
  if (!requiredScope) return true;
  if (!ctx) return !isApiAuthEnabled();

  const scopes = new Set((ctx.scopes || []).map(normalizeScope));
  if (scopes.has('*') || scopes.has('admin')) return true;

  const required = normalizeScope(requiredScope);
  if (scopes.has(required)) return true;

  const [resource, action] = required.split(':');
  if (!resource || !action) return false;

  const aliases = [
    `${action}:${resource}`,
    `${resource}:*`,
    `*:${action}`,
    `${action}:*`,
  ];
  if (aliases.some(scope => scopes.has(scope))) return true;

  // A resource write scope implies read access for the same resource.
  if (action === 'read') {
    return scopes.has(`${resource}:write`) || scopes.has(`write:${resource}`);
  }

  return false;
}

function requiredScopeForRequest(req: Request): string | undefined {
  if (req.method === 'OPTIONS') return undefined;
  const segments = req.path.split('/').filter(Boolean);
  if (segments[0] && /^v\d+$/i.test(segments[0])) segments.shift();
  const resource = segments[0]?.replace(/[^a-zA-Z0-9-]/g, '').toLowerCase();
  if (!resource || resource === 'health') return undefined;
  const access = req.method === 'GET' || req.method === 'HEAD' ? 'read' : 'write';
  return `${resource}:${access}`;
}

export function createApiAuthMiddleware(options?: { publicPaths?: string[] }) {
  const publicPaths = new Set(options?.publicPaths || []);

  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'OPTIONS') return next();
    if (publicPaths.has(req.path)) return next();

    if (!isApiAuthEnabled()) {
      (req as any).authContext = resolveApiAuthContext();
      return next();
    }

    const token = tokenFromAuthorizationHeader(req.header('authorization'));
    const authContext = resolveApiAuthContext(token);
    if (!authContext) {
      const code = token ? 'AUTH_INVALID' : 'AUTH_REQUIRED';
      return res.status(401).json({
        error: {
          code,
          message: token ? 'Authorization token is invalid' : 'Authorization header with Bearer token is required',
        },
      });
    }

    const requiredScope = requiredScopeForRequest(req);
    if (!hasApiScope(authContext, requiredScope)) {
      return res.status(403).json({
        error: {
          code: 'AUTH_FORBIDDEN',
          message: `API key is missing required scope: ${requiredScope}`,
        },
      });
    }

    (req as any).authContext = authContext;
    return next();
  };
}
