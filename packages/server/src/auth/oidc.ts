/**
 * OAuth2/OIDC Authentication Module
 *
 * Supports multiple identity providers:
 * - Google
 * - GitHub
 * - Enterprise OIDC (Okta, Azure AD, etc.)
 *
 * Security features:
 * - State parameter with TTL to prevent CSRF
 * - PKCE (S256) to prevent authorization code interception
 * - Short-lived access tokens (15min) with refresh token rotation
 * - Token blacklist (revoked_tokens table) checked in session middleware
 * - Refresh token stored hashed in DB (refresh_tokens table)
 *
 * Configuration via environment variables:
 * - AUTH_MODE=oidc|local (default: local for development)
 * - OIDC_ISSUER — OpenID Connect discovery URL
 * - OIDC_CLIENT_ID — Client ID
 * - OIDC_CLIENT_SECRET — Client secret
 * - OIDC_REDIRECT_URI — Redirect URI after auth
 * - SESSION_SECRET — Secret for JWT session signing
 */

import { Router, type RequestHandler } from 'express';
import { createUser } from './tenant.js';
import { getDb } from '../db/database.js';
import { logger } from '../lib/logger.js';
import { v4 as uuid } from 'uuid';
import { randomBytes, createHmac, createHash } from 'crypto';

// ---------- Types ----------

export interface OIDCConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
}

export interface AuthSession {
  jti: string;
  userId: string;
  email: string;
  name: string;
  orgId: string;
  expiresAt: number;
}

// ---------- State Store (CSRF protection with 5min TTL) ----------

interface StateEntry {
  codeVerifier: string;
  createdAt: number;
}

const STATE_TTL_MS = 5 * 60 * 1000;
const pendingStates = new Map<string, StateEntry>();

// Cleanup expired states every 60s
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of pendingStates) {
    if (now - entry.createdAt > STATE_TTL_MS) {
      pendingStates.delete(key);
    }
  }
}, 60_000).unref();

// ---------- PKCE helpers ----------

function generateCodeVerifier(): string {
  // 43-128 chars from unreserved URI chars
  return randomBytes(64).toString('base64url').slice(0, 96);
}

function computeCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

// ---------- JWT helpers ----------

function base64url(str: string): string {
  return Buffer.from(str).toString('base64url');
}

function createSessionToken(session: AuthSession, secret: string): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify(session));
  const signature = createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

function verifySessionToken(token: string, secret: string): AuthSession | null {
  try {
    const [header, payload, signature] = token.split('.');
    const expected = createHmac('sha256', secret)
      .update(`${header}.${payload}`)
      .digest('base64url');
    if (signature !== expected) return null;
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString()) as AuthSession;
    if (session.expiresAt < Date.now()) return null;
    return session;
  } catch {
    return null;
  }
}

// ---------- Refresh token helpers ----------

function generateRefreshToken(): string {
  return randomBytes(64).toString('hex').slice(0, 64);
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// ---------- DB schema initialization ----------

function ensureAuthTables(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS revoked_tokens (
      jti TEXT PRIMARY KEY,
      revoked_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )
  `);
}

let tablesEnsured = false;
function ensureTablesOnce(): void {
  if (!tablesEnsured) {
    ensureAuthTables();
    tablesEnsured = true;
  }
}

// ---------- OIDC Config ----------

function getOIDCConfig(): OIDCConfig | null {
  const issuer = process.env.OIDC_ISSUER;
  const clientId = process.env.OIDC_CLIENT_ID;
  const clientSecret = process.env.OIDC_CLIENT_SECRET;
  if (!issuer || !clientId || !clientSecret) return null;
  return {
    issuer,
    clientId,
    clientSecret,
    redirectUri: process.env.OIDC_REDIRECT_URI || 'http://localhost:3000/auth/callback',
    scopes: ['openid', 'email', 'profile'],
  };
}

// ---------- Auth Routes ----------

export function createAuthRoutes(): Router {
  const router = Router();
  const secret = process.env.SESSION_SECRET || 'dev-secret-change-in-production';

  ensureTablesOnce();

  // GET /auth/login — initiate OIDC login
  router.get('/login', async (_req, res) => {
    const config = getOIDCConfig();
    if (!config) {
      return res.status(501).json({ error: { message: 'OIDC not configured. Set OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET.' } });
    }

    try {
      const discovery = await fetch(`${config.issuer}/.well-known/openid-configuration`).then(r => r.json());
      const authUrl = new URL(discovery.authorization_endpoint);

      // State parameter (CSRF protection)
      const state = randomBytes(32).toString('hex');

      // PKCE
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = computeCodeChallenge(codeVerifier);

      // Store state -> codeVerifier mapping
      pendingStates.set(state, { codeVerifier, createdAt: Date.now() });

      authUrl.searchParams.set('client_id', config.clientId);
      authUrl.searchParams.set('redirect_uri', config.redirectUri);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', config.scopes.join(' '));
      authUrl.searchParams.set('state', state);
      authUrl.searchParams.set('code_challenge', codeChallenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');

      res.redirect(authUrl.toString());
    } catch (err: any) {
      logger.error({ err }, 'OIDC discovery failed');
      res.status(500).json({ error: { message: 'OIDC discovery failed' } });
    }
  });

  // GET /auth/callback — handle OIDC callback
  router.get('/callback', async (req, res) => {
    const config = getOIDCConfig();
    if (!config) return res.status(501).json({ error: { message: 'OIDC not configured' } });

    const code = req.query.code as string;
    const state = req.query.state as string;
    if (!code) return res.status(400).json({ error: { message: 'Missing code parameter' } });
    if (!state) return res.status(400).json({ error: { message: 'Missing state parameter' } });

    // Verify state
    const stateEntry = pendingStates.get(state);
    if (!stateEntry) {
      return res.status(403).json({ error: { message: 'Invalid or expired state parameter' } });
    }
    pendingStates.delete(state);

    // Check TTL
    if (Date.now() - stateEntry.createdAt > STATE_TTL_MS) {
      return res.status(403).json({ error: { message: 'State parameter expired' } });
    }

    try {
      // Exchange code for tokens (with PKCE code_verifier)
      const discovery = await fetch(`${config.issuer}/.well-known/openid-configuration`).then(r => r.json());
      const tokenRes = await fetch(discovery.token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: config.redirectUri,
          client_id: config.clientId,
          client_secret: config.clientSecret,
          code_verifier: stateEntry.codeVerifier,
        }),
      }).then(r => r.json());

      if (tokenRes.error) throw new Error(tokenRes.error_description || tokenRes.error);

      // Get user info
      const userInfo = await fetch(discovery.userinfo_endpoint, {
        headers: { Authorization: `Bearer ${tokenRes.access_token}` },
      }).then(r => r.json());

      // Find or create user
      const db = getDb();
      let user = db.get('SELECT * FROM users WHERE email = ?', userInfo.email) as any;

      if (!user) {
        const orgId = `org_${uuid().slice(0, 8)}`;
        db.run('INSERT INTO organizations (id, name) VALUES (?, ?)', orgId, userInfo.email.split('@')[1] || 'default');
        user = createUser({
          orgId,
          email: userInfo.email,
          name: userInfo.name || userInfo.email,
          role: 'admin',
        });
        const wsId = `ws_${uuid().slice(0, 8)}`;
        db.run('INSERT INTO workspaces (id, org_id, name) VALUES (?, ?, ?)', wsId, orgId, 'Default');
        db.run('INSERT INTO workspace_memberships (user_id, workspace_id, role) VALUES (?, ?, ?)', user.id, wsId, 'admin');
      }

      // Create session token (15min expiry)
      const jti = uuid();
      const session: AuthSession = {
        jti,
        userId: user.id,
        email: user.email,
        name: user.name,
        orgId: user.org_id,
        expiresAt: Date.now() + 15 * 60 * 1000, // 15 minutes
      };
      const token = createSessionToken(session, secret);

      // Issue refresh token (stored hashed in DB)
      const refreshToken = generateRefreshToken();
      const refreshHash = hashToken(refreshToken);
      const refreshExpiry = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days
      db.run(
        'INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
        uuid(), user.id, refreshHash, refreshExpiry, Date.now()
      );

      // Redirect to dashboard with tokens
      res.redirect(`/?token=${token}&refresh_token=${refreshToken}`);
    } catch (err: any) {
      logger.error({ err }, 'OIDC callback failed');
      res.status(500).json({ error: { message: `Authentication failed: ${err.message}` } });
    }
  });

  // GET /auth/me — get current session
  router.get('/me', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: { message: 'No session' } });
    }
    const session = verifySessionToken(authHeader.slice(7), secret);
    if (!session) return res.status(401).json({ error: { message: 'Invalid or expired session' } });

    // Check blacklist
    const db = getDb();
    const revoked = db.get('SELECT jti FROM revoked_tokens WHERE jti = ?', session.jti) as any;
    if (revoked) return res.status(401).json({ error: { message: 'Token revoked' } });

    res.json(session);
  });

  // POST /auth/refresh — exchange refresh token for new access + refresh tokens
  router.post('/refresh', (req, res) => {
    const { refresh_token } = req.body || {};
    if (!refresh_token) {
      return res.status(400).json({ error: { message: 'Missing refresh_token' } });
    }

    const db = getDb();
    const tokenHash = hashToken(refresh_token);
    const row = db.get('SELECT * FROM refresh_tokens WHERE token_hash = ?', tokenHash) as any;

    if (!row) {
      return res.status(401).json({ error: { message: 'Invalid refresh token' } });
    }

    if (row.expires_at < Date.now()) {
      db.run('DELETE FROM refresh_tokens WHERE id = ?', row.id);
      return res.status(401).json({ error: { message: 'Refresh token expired' } });
    }

    // Delete old refresh token (rotation)
    db.run('DELETE FROM refresh_tokens WHERE id = ?', row.id);

    // Look up user
    const user = db.get('SELECT * FROM users WHERE id = ?', row.user_id) as any;
    if (!user) {
      return res.status(401).json({ error: { message: 'User not found' } });
    }

    // Issue new access token
    const jti = uuid();
    const session: AuthSession = {
      jti,
      userId: user.id,
      email: user.email,
      name: user.name,
      orgId: user.org_id,
      expiresAt: Date.now() + 15 * 60 * 1000,
    };
    const newAccessToken = createSessionToken(session, secret);

    // Issue new refresh token
    const newRefreshToken = generateRefreshToken();
    const newRefreshHash = hashToken(newRefreshToken);
    const refreshExpiry = Date.now() + 30 * 24 * 60 * 60 * 1000;
    db.run(
      'INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
      uuid(), user.id, newRefreshHash, refreshExpiry, Date.now()
    );

    res.json({
      access_token: newAccessToken,
      refresh_token: newRefreshToken,
      expires_in: 900, // 15 minutes in seconds
    });
  });

  // POST /auth/logout — revoke tokens
  router.post('/logout', (req, res) => {
    const db = getDb();

    // Revoke access token (blacklist jti)
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      const session = verifySessionToken(authHeader.slice(7), secret);
      if (session) {
        db.run(
          'INSERT OR IGNORE INTO revoked_tokens (jti, revoked_at, expires_at) VALUES (?, ?, ?)',
          session.jti, Date.now(), session.expiresAt
        );
      }
    }

    // Revoke refresh token
    const { refresh_token } = req.body || {};
    if (refresh_token) {
      const tokenHash = hashToken(refresh_token);
      db.run('DELETE FROM refresh_tokens WHERE token_hash = ?', tokenHash);
    }

    res.json({ success: true });
  });

  return router;
}

/**
 * Session auth middleware — validates JWT Bearer token and populates req.tenantContext.
 * Checks token blacklist (revoked_tokens table).
 * Used alongside tenantMiddleware for production mode.
 */
export function sessionAuthMiddleware(): RequestHandler {
  const secret = process.env.SESSION_SECRET || 'dev-secret-change-in-production';
  const authMode = process.env.AUTH_MODE || 'local';

  return (req, _res, next) => {
    if (authMode === 'local') return next(); // Skip in local mode

    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      const session = verifySessionToken(authHeader.slice(7), secret);
      if (session) {
        // Check token blacklist
        const db = getDb();
        const revoked = db.get('SELECT jti FROM revoked_tokens WHERE jti = ?', session.jti) as any;
        if (revoked) return next(); // Token revoked, don't populate context

        // Populate tenant context from session
        const workspaceId = req.headers['x-workspace-id'] as string;
        if (workspaceId) {
          const membership = db.get(
            'SELECT role FROM workspace_memberships WHERE user_id = ? AND workspace_id = ?',
            session.userId, workspaceId
          ) as { role: string } | undefined;
          if (membership) {
            (req as any).tenantContext = {
              userId: session.userId,
              orgId: session.orgId,
              workspaceId,
              role: membership.role,
            };
          }
        }
      }
    }
    next();
  };
}
