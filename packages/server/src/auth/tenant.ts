/**
 * Multi-Tenancy & RBAC Module
 *
 * Data model:
 *   Organization → Workspace → User (with role)
 *
 * Roles:
 *   - admin: full access (create/delete workspaces, manage users)
 *   - operator: manage agents, tasks, pipelines within workspace
 *   - viewer: read-only access
 *
 * All resource tables get a workspace_id column (Phase 2 migration).
 * Middleware injects tenant context into every request.
 */

import { getDb } from '../db/database.js';
import { v4 as uuid } from 'uuid';
import type { RequestHandler } from 'express';

// ---------- Types ----------

export type Role = 'admin' | 'operator' | 'viewer';

export interface Organization {
  id: string;
  name: string;
  createdAt: string;
}

export interface Workspace {
  id: string;
  orgId: string;
  name: string;
  createdAt: string;
}

export interface User {
  id: string;
  orgId: string;
  email: string;
  name: string;
  role: Role;
  createdAt: string;
}

export interface WorkspaceMembership {
  userId: string;
  workspaceId: string;
  role: Role;
  createdAt: string;
}

export interface TenantContext {
  userId: string;
  orgId: string;
  workspaceId: string;
  role: Role;
}

// ---------- Schema (will be applied via migration) ----------

export const TENANT_SCHEMA = `
-- Multi-tenancy tables
CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer' CHECK(role IN ('admin','operator','viewer')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS workspace_memberships (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'viewer' CHECK(role IN ('admin','operator','viewer')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_workspaces_org ON workspaces(org_id);
CREATE INDEX IF NOT EXISTS idx_users_org ON users(org_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_workspace_memberships_workspace ON workspace_memberships(workspace_id);
`;

// ---------- CRUD ----------

export function createOrganization(name: string): Organization {
  const db = getDb();
  const id = `org_${uuid().slice(0, 8)}`;
  db.run('INSERT INTO organizations (id, name) VALUES (?, ?)', id, name);
  return db.get('SELECT * FROM organizations WHERE id = ?', id) as Organization;
}

export function createWorkspace(orgId: string, name: string): Workspace {
  const db = getDb();
  const id = `ws_${uuid().slice(0, 8)}`;
  db.run('INSERT INTO workspaces (id, org_id, name) VALUES (?, ?, ?)', id, orgId, name);
  return db.get('SELECT * FROM workspaces WHERE id = ?', id) as Workspace;
}

export function createUser(data: { orgId: string; email: string; name: string; role?: Role }): User {
  const db = getDb();
  const id = `user_${uuid().slice(0, 8)}`;
  db.run(
    'INSERT INTO users (id, org_id, email, name, role) VALUES (?, ?, ?, ?, ?)',
    id, data.orgId, data.email, data.name, data.role || 'viewer'
  );
  return db.get('SELECT * FROM users WHERE id = ?', id) as User;
}

export function addWorkspaceMember(userId: string, workspaceId: string, role: Role): void {
  const db = getDb();
  db.run(
    'INSERT INTO workspace_memberships (user_id, workspace_id, role) VALUES (?, ?, ?) ON CONFLICT(user_id, workspace_id) DO UPDATE SET role = ?',
    userId, workspaceId, role, role
  );
}

export function getUserWorkspaces(userId: string): (Workspace & { role: Role })[] {
  const db = getDb();
  return db.all(`
    SELECT w.*, wm.role FROM workspaces w
    JOIN workspace_memberships wm ON wm.workspace_id = w.id
    WHERE wm.user_id = ?
  `, userId);
}

export function getWorkspaceMembers(workspaceId: string): (User & { workspaceRole: Role })[] {
  const db = getDb();
  return db.all(`
    SELECT u.*, wm.role as workspace_role FROM users u
    JOIN workspace_memberships wm ON wm.user_id = u.id
    WHERE wm.workspace_id = ?
  `, workspaceId);
}

// ---------- RBAC Middleware ----------

const ROLE_HIERARCHY: Record<Role, number> = { admin: 3, operator: 2, viewer: 1 };

export function requireRole(minRole: Role): RequestHandler {
  return (req, res, next) => {
    const ctx = (req as any).tenantContext as TenantContext | undefined;
    if (!ctx) {
      return res.status(401).json({ error: { message: 'Authentication required' } });
    }
    if (ROLE_HIERARCHY[ctx.role] < ROLE_HIERARCHY[minRole]) {
      return res.status(403).json({ error: { message: `Requires ${minRole} role or higher` } });
    }
    next();
  };
}

/**
 * Middleware that extracts tenant context from the request.
 * In production, this reads from the JWT/session.
 * For development, it uses X-Workspace-Id and X-User-Id headers.
 */
export function tenantMiddleware(): RequestHandler {
  return (req, res, next) => {
    const authContext = (req as any).authContext as { kind?: string; userId?: string; workspaceId?: string; scopes?: string[] } | undefined;
    const userId = req.header('x-user-id') || authContext?.userId || 'local-admin';
    const requestedWorkspaceId = req.header('x-workspace-id') || authContext?.workspaceId || 'default';

    if (authContext?.kind === 'api-key' && authContext.workspaceId !== requestedWorkspaceId) {
      return res.status(403).json({
        error: {
          code: 'WORKSPACE_FORBIDDEN',
          message: 'API key is not authorized for the requested workspace',
        },
      });
    }

    if (userId && requestedWorkspaceId) {
      const db = getDb();
      const membership = db.get(
        'SELECT wm.role, w.org_id FROM workspace_memberships wm JOIN workspaces w ON w.id = wm.workspace_id WHERE wm.user_id = ? AND wm.workspace_id = ?',
        userId, requestedWorkspaceId
      ) as { role: Role; org_id: string } | undefined;

      if (membership) {
        (req as any).tenantContext = {
          userId,
          workspaceId: requestedWorkspaceId,
          orgId: membership.org_id,
          role: membership.role,
        } as TenantContext;
      } else if (authContext) {
        (req as any).tenantContext = {
          userId,
          workspaceId: requestedWorkspaceId,
          orgId: 'default',
          role: roleFromScopes(authContext.scopes || []),
        } as TenantContext;
      }
    }

    next();
  };
}

function roleFromScopes(scopes: string[]): Role {
  const normalized = scopes.map(scope => scope.toLowerCase());
  if (normalized.some(scope => scope === 'admin' || scope === '*' || scope.endsWith(':admin'))) return 'admin';
  if (normalized.some(scope => scope.includes(':write') || scope.startsWith('write:'))) return 'operator';
  return 'viewer';
}

/**
 * Helper to add workspace_id filter to queries.
 * Returns the SQL condition and param to append.
 */
export function workspaceFilter(req: any): { condition: string; param: string } | null {
  const ctx = (req as any).tenantContext as TenantContext | undefined;
  if (!ctx) return null;
  return { condition: 'workspace_id = ?', param: ctx.workspaceId };
}

export function workspaceIdFromRequest(req: any): string | undefined {
  return (req as any).tenantContext?.workspaceId
    || (req as any).authContext?.workspaceId
    || undefined;
}

export function requestCanAccessWorkspace(req: any, workspaceId?: string | null): boolean {
  const requestWorkspaceId = workspaceIdFromRequest(req);
  if (!requestWorkspaceId) return true;
  return (workspaceId || 'default') === requestWorkspaceId;
}
