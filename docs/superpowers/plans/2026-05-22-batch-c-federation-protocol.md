# Batch C: Agent Federation Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add capability-based agent discovery, inter-agent communication (sync/async), and shared artifact storage with access control.

**Architecture:** Three loosely-coupled modules — CapabilityRegistry indexes agent capabilities for discovery, AgentComms provides sync request/response and async messaging between agents, SharedArtifactStore manages intermediate work products with capability-based read permissions. All use existing EventBus, TaskQueue, and AgentRuntime patterns.

**Tech Stack:** TypeScript, SQLite (better-sqlite3), existing EventBus/AgentRuntime infrastructure.

---

### Task 1: Shared types for federation

**Files:**
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Add federation types**

Append to `packages/shared/src/index.ts`:

```typescript
// ---------- Agent Federation ----------

export interface CommRequest {
  from: string;
  capability: string;
  payload: any;
  timeout?: number;
}

export interface CommMessage {
  from: string;
  capability: string;
  payload: any;
  replyTo?: string;
}

export interface CommResponse {
  success: boolean;
  providerId: string;
  output: any;
  durationMs: number;
}

export interface CommMessageRecord {
  id: string;
  fromAgentId: string;
  toAgentId: string;
  capability: string;
  mode: 'sync' | 'async';
  status: 'pending' | 'running' | 'done' | 'failed' | 'timeout';
  payloadSummary: string | null;
  taskId: string | null;
  outputSummary: string | null;
  durationMs: number | null;
  createdAt: string;
  completedAt: string | null;
}

export interface Artifact {
  id: string;
  ownerId: string;
  name: string;
  content: string;
  readableBy: string[];
  expiresAt: string;
  createdAt: string;
}
```

Also add to WSEventType union:
```
  | 'agent:comm:request' | 'agent:comm:response' | 'agent:comm:message'
  | 'artifact:published' | 'artifact:read'
```

- [ ] **Step 2: Commit**

```bash
git add packages/shared/src/index.ts
git commit -m "feat: add shared types for agent federation protocol"
```

---

### Task 2: Agent Comm Log DB model

**Files:**
- Create: `packages/server/src/db/models/agent-comm-log.ts`
- Modify: `packages/server/src/db/database.ts`

- [ ] **Step 1: Write the test**

Create `packages/server/src/db/models/__tests__/agent-comm-log.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { createCommLog, getCommLog, updateCommLog, listCommLogs } from '../agent-comm-log.js';

describe('agent-comm-log model', () => {
  it('creates and retrieves a comm log', () => {
    const log = createCommLog({
      fromAgentId: 'dev',
      toAgentId: 'review',
      capability: 'code-review',
      mode: 'sync',
      payloadSummary: 'Review this code...',
    });
    expect(log.id).toMatch(/^comm_/);
    expect(log.status).toBe('pending');

    const fetched = getCommLog(log.id);
    expect(fetched).toEqual(log);
  });

  it('updates status and output', () => {
    const log = createCommLog({
      fromAgentId: 'dev',
      toAgentId: 'qa',
      capability: 'testing',
      mode: 'async',
      payloadSummary: 'Run tests',
    });

    const updated = updateCommLog(log.id, {
      status: 'done',
      outputSummary: 'All tests passed',
      durationMs: 5000,
      completedAt: new Date().toISOString(),
    });
    expect(updated?.status).toBe('done');
    expect(updated?.durationMs).toBe(5000);
  });

  it('lists logs filtered by capability', () => {
    createCommLog({
      fromAgentId: 'dev',
      toAgentId: 'review',
      capability: 'code-review',
      mode: 'sync',
      payloadSummary: 'test',
    });
    const logs = listCommLogs({ capability: 'code-review' });
    expect(logs.length).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/server/src/db/models/__tests__/agent-comm-log.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Add schema to database.ts**

In `packages/server/src/db/database.ts`, add to the module schemas:

```sql
CREATE TABLE IF NOT EXISTS agent_comm_log (
  id TEXT PRIMARY KEY,
  from_agent_id TEXT NOT NULL,
  to_agent_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('sync', 'async')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'done', 'failed', 'timeout')),
  payload_summary TEXT,
  task_id TEXT,
  output_summary TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);
```

- [ ] **Step 4: Create agent-comm-log.ts**

Create `packages/server/src/db/models/agent-comm-log.ts`:

```typescript
import { getDb } from '../database.js';
import { v4 as uuid } from 'uuid';
import type { CommMessageRecord } from '../../types.js';

function rowToRecord(row: any): CommMessageRecord {
  return {
    id: row.id,
    fromAgentId: row.from_agent_id,
    toAgentId: row.to_agent_id,
    capability: row.capability,
    mode: row.mode,
    status: row.status,
    payloadSummary: row.payload_summary,
    taskId: row.task_id,
    outputSummary: row.output_summary,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

export function createCommLog(data: {
  fromAgentId: string;
  toAgentId: string;
  capability: string;
  mode: 'sync' | 'async';
  payloadSummary?: string;
  taskId?: string;
}): CommMessageRecord {
  const db = getDb();
  const id = `comm_${uuid().slice(0, 8)}`;
  db.run(`
    INSERT INTO agent_comm_log (id, from_agent_id, to_agent_id, capability, mode, payload_summary, task_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, id, data.fromAgentId, data.toAgentId, data.capability, data.mode, data.payloadSummary || null, data.taskId || null);
  return getCommLog(id)!;
}

export function getCommLog(id: string): CommMessageRecord | undefined {
  const db = getDb();
  const row = db.get('SELECT * FROM agent_comm_log WHERE id = ?', id);
  return row ? rowToRecord(row) : undefined;
}

export function updateCommLog(id: string, updates: {
  status?: string;
  taskId?: string;
  outputSummary?: string;
  durationMs?: number;
  completedAt?: string;
}): CommMessageRecord | undefined {
  const db = getDb();
  const sets: string[] = [];
  const params: any[] = [];
  if (updates.status !== undefined) { sets.push('status = ?'); params.push(updates.status); }
  if (updates.taskId !== undefined) { sets.push('task_id = ?'); params.push(updates.taskId); }
  if (updates.outputSummary !== undefined) { sets.push('output_summary = ?'); params.push(updates.outputSummary); }
  if (updates.durationMs !== undefined) { sets.push('duration_ms = ?'); params.push(updates.durationMs); }
  if (updates.completedAt !== undefined) { sets.push('completed_at = ?'); params.push(updates.completedAt); }
  if (sets.length === 0) return getCommLog(id);
  params.push(id);
  db.run(`UPDATE agent_comm_log SET ${sets.join(', ')} WHERE id = ?`, ...params);
  return getCommLog(id);
}

export function listCommLogs(filter?: {
  fromAgentId?: string;
  toAgentId?: string;
  capability?: string;
  mode?: string;
  status?: string;
  limit?: number;
}): CommMessageRecord[] {
  const db = getDb();
  let sql = 'SELECT * FROM agent_comm_log';
  const conditions: string[] = [];
  const params: any[] = [];
  if (filter?.fromAgentId) { conditions.push('from_agent_id = ?'); params.push(filter.fromAgentId); }
  if (filter?.toAgentId) { conditions.push('to_agent_id = ?'); params.push(filter.toAgentId); }
  if (filter?.capability) { conditions.push('capability = ?'); params.push(filter.capability); }
  if (filter?.mode) { conditions.push('mode = ?'); params.push(filter.mode); }
  if (filter?.status) { conditions.push('status = ?'); params.push(filter.status); }
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY created_at DESC';
  if (filter?.limit) { sql += ' LIMIT ?'; params.push(filter.limit); }
  return db.all(sql, ...params).map(rowToRecord);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/server/src/db/models/__tests__/agent-comm-log.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/db/models/agent-comm-log.ts packages/server/src/db/models/__tests__/agent-comm-log.test.ts packages/server/src/db/database.ts
git commit -m "feat: add agent_comm_log DB model"
```

---

### Task 3: Shared Artifact DB model

**Files:**
- Create: `packages/server/src/db/models/shared-artifact.ts`
- Modify: `packages/server/src/db/database.ts`

- [ ] **Step 1: Write the test**

Create `packages/server/src/db/models/__tests__/shared-artifact.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { createArtifact, getArtifact, listArtifacts, deleteExpiredArtifacts } from '../shared-artifact.js';

describe('shared-artifact model', () => {
  it('creates and retrieves an artifact', () => {
    const art = createArtifact({
      ownerId: 'dev',
      name: 'code-output',
      content: 'function hello() { return "world"; }',
      readableBy: ['testing', 'code-review'],
      ttlHours: 24,
    });
    expect(art.id).toMatch(/^art_/);
    expect(art.readableBy).toEqual(['testing', 'code-review']);

    const fetched = getArtifact(art.id);
    expect(fetched?.name).toBe('code-output');
  });

  it('lists artifacts by ownerId', () => {
    createArtifact({
      ownerId: 'dev-list',
      name: 'test-artifact',
      content: 'content',
      readableBy: ['testing'],
      ttlHours: 24,
    });
    const arts = listArtifacts({ ownerId: 'dev-list' });
    expect(arts.length).toBeGreaterThanOrEqual(1);
  });

  it('deletes expired artifacts', () => {
    // Create artifact with already-expired time
    const art = createArtifact({
      ownerId: 'dev-expired',
      name: 'old-artifact',
      content: 'expired content',
      readableBy: [],
      ttlHours: -1, // already expired
    });
    const deleted = deleteExpiredArtifacts();
    expect(deleted).toBeGreaterThanOrEqual(1);
    expect(getArtifact(art.id)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/server/src/db/models/__tests__/shared-artifact.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Add schema to database.ts**

In `packages/server/src/db/database.ts`, add:

```sql
CREATE TABLE IF NOT EXISTS shared_artifacts (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  readable_by TEXT NOT NULL DEFAULT '[]',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- [ ] **Step 4: Create shared-artifact.ts**

Create `packages/server/src/db/models/shared-artifact.ts`:

```typescript
import { getDb } from '../database.js';
import { v4 as uuid } from 'uuid';
import type { Artifact } from '../../types.js';

function rowToArtifact(row: any): Artifact {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    content: row.content,
    readableBy: JSON.parse(row.readable_by || '[]'),
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

export function createArtifact(data: {
  ownerId: string;
  name: string;
  content: string;
  readableBy: string[];
  ttlHours?: number;
}): Artifact {
  const db = getDb();
  const id = `art_${uuid().slice(0, 8)}`;
  const ttl = data.ttlHours ?? 24;
  const expiresAt = new Date(Date.now() + ttl * 60 * 60 * 1000).toISOString();
  db.run(`
    INSERT INTO shared_artifacts (id, owner_id, name, content, readable_by, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `, id, data.ownerId, data.name, data.content, JSON.stringify(data.readableBy), expiresAt);
  return getArtifact(id)!;
}

export function getArtifact(id: string): Artifact | undefined {
  const db = getDb();
  const row = db.get('SELECT * FROM shared_artifacts WHERE id = ?', id);
  return row ? rowToArtifact(row) : undefined;
}

export function listArtifacts(filter?: { ownerId?: string; limit?: number }): Artifact[] {
  const db = getDb();
  let sql = 'SELECT * FROM shared_artifacts';
  const conditions: string[] = [];
  const params: any[] = [];
  if (filter?.ownerId) { conditions.push('owner_id = ?'); params.push(filter.ownerId); }
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY created_at DESC';
  if (filter?.limit) { sql += ' LIMIT ?'; params.push(filter.limit); }
  return db.all(sql, ...params).map(rowToArtifact);
}

export function deleteExpiredArtifacts(): number {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db.run('DELETE FROM shared_artifacts WHERE expires_at < ?', now);
  return result.changes;
}

export function deleteArtifact(id: string): boolean {
  const db = getDb();
  const result = db.run('DELETE FROM shared_artifacts WHERE id = ?', id);
  return result.changes > 0;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/server/src/db/models/__tests__/shared-artifact.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/db/models/shared-artifact.ts packages/server/src/db/models/__tests__/shared-artifact.test.ts packages/server/src/db/database.ts
git commit -m "feat: add shared_artifacts DB model"
```

---

### Task 4: Capability Registry

**Files:**
- Create: `packages/server/src/agents/capability-registry.ts`

- [ ] **Step 1: Write the test**

Create `packages/server/src/agents/__tests__/capability-registry.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CapabilityRegistry } from '../capability-registry.js';

vi.mock('../../db/models/agent.js', () => ({
  listAgents: vi.fn(() => [
    { id: 'dev', name: 'Developer', capabilities: ['coding', 'debugging'], config: { maxConcurrent: 2 } },
    { id: 'review', name: 'Reviewer', capabilities: ['code-review', 'testing'], config: { maxConcurrent: 1 } },
    { id: 'qa', name: 'QA', capabilities: ['testing', 'security-scan'], config: { maxConcurrent: 1 } },
  ]),
}));
vi.mock('../../db/models/execution.js', () => ({
  getActiveExecutionCount: vi.fn(() => 0),
}));
vi.mock('../../events/event-bus.js', () => ({
  eventBus: { on: vi.fn() },
}));

import { getActiveExecutionCount } from '../../db/models/execution.js';

describe('CapabilityRegistry', () => {
  let registry: CapabilityRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new CapabilityRegistry();
    registry.buildIndex();
  });

  it('finds provider for a capability', () => {
    const provider = registry.findProvider('code-review');
    expect(provider?.id).toBe('review');
  });

  it('returns undefined for unknown capability', () => {
    const provider = registry.findProvider('nonexistent');
    expect(provider).toBeUndefined();
  });

  it('finds all providers for a capability', () => {
    const providers = registry.findAllProviders('testing');
    expect(providers).toHaveLength(2);
    const ids = providers.map(p => p.id);
    expect(ids).toContain('review');
    expect(ids).toContain('qa');
  });

  it('skips agents at capacity', () => {
    (getActiveExecutionCount as any).mockReturnValue(1);
    const provider = registry.findProvider('code-review');
    expect(provider).toBeUndefined(); // review agent has maxConcurrent=1
  });

  it('getAgentCapabilities returns capabilities for an agent', () => {
    const caps = registry.getAgentCapabilities('dev');
    expect(caps).toEqual(['coding', 'debugging']);
  });

  it('returns empty for unknown agent', () => {
    const caps = registry.getAgentCapabilities('unknown');
    expect(caps).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/server/src/agents/__tests__/capability-registry.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement CapabilityRegistry**

Create `packages/server/src/agents/capability-registry.ts`:

```typescript
import { listAgents } from '../db/models/agent.js';
import { getActiveExecutionCount } from '../db/models/execution.js';
import { eventBus } from '../events/event-bus.js';
import { logger } from '../lib/logger.js';
import type { AgentDefinition } from '../types.js';

export class CapabilityRegistry {
  private capabilityToAgents = new Map<string, string[]>();
  private agentToCapabilities = new Map<string, string[]>();
  private agentsById = new Map<string, AgentDefinition>();

  constructor() {
    eventBus.on('agent:status', () => this.refresh());
  }

  /** Build the capability index from DB */
  buildIndex(): void {
    this.capabilityToAgents.clear();
    this.agentToCapabilities.clear();
    this.agentsById.clear();

    const agents = listAgents();
    for (const agent of agents) {
      this.agentsById.set(agent.id, agent);
      const caps = agent.capabilities || [];
      this.agentToCapabilities.set(agent.id, caps);

      for (const cap of caps) {
        const existing = this.capabilityToAgents.get(cap) || [];
        existing.push(agent.id);
        this.capabilityToAgents.set(cap, existing);
      }
    }

    logger.info({ capabilities: this.capabilityToAgents.size, agents: agents.length }, 'Capability index built');
  }

  /** Refresh the index */
  refresh(): void {
    this.buildIndex();
  }

  /** Find one available agent providing a capability */
  findProvider(capability: string): AgentDefinition | undefined {
    const agentIds = this.capabilityToAgents.get(capability);
    if (!agentIds || agentIds.length === 0) return undefined;

    const available = agentIds
      .map(id => this.agentsById.get(id))
      .filter((a): a is AgentDefinition => {
        if (!a) return false;
        const active = getActiveExecutionCount(a.id);
        return active < (a.config.maxConcurrent || 1);
      });

    if (available.length === 0) return undefined;
    if (available.length === 1) return available[0];

    // Weighted selection by routeWeight
    const weights = available.map(a => (a as any).routeWeight ?? 1.0);
    const totalWeight = weights.reduce((sum, w) => sum + w, 0);
    let rand = Math.random() * totalWeight;
    for (let i = 0; i < available.length; i++) {
      rand -= weights[i];
      if (rand <= 0) return available[i];
    }
    return available[available.length - 1];
  }

  /** Find all agents providing a capability */
  findAllProviders(capability: string): AgentDefinition[] {
    const agentIds = this.capabilityToAgents.get(capability) || [];
    return agentIds
      .map(id => this.agentsById.get(id))
      .filter((a): a is AgentDefinition => !!a);
  }

  /** Get capabilities for a specific agent */
  getAgentCapabilities(agentId: string): string[] {
    return this.agentToCapabilities.get(agentId) || [];
  }

  /** List all known capabilities */
  listCapabilities(): Array<{ capability: string; providerCount: number }> {
    return Array.from(this.capabilityToAgents.entries()).map(([capability, agents]) => ({
      capability,
      providerCount: agents.length,
    }));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/server/src/agents/__tests__/capability-registry.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/agents/capability-registry.ts packages/server/src/agents/__tests__/capability-registry.test.ts
git commit -m "feat: add capability registry for agent discovery"
```

---

### Task 5: Shared Artifact Store

**Files:**
- Create: `packages/server/src/agents/shared-artifact-store.ts`
- Create: `packages/server/src/workers/artifact-cleanup.ts`

- [ ] **Step 1: Write the test**

Create `packages/server/src/agents/__tests__/shared-artifact-store.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SharedArtifactStore } from '../shared-artifact-store.js';

vi.mock('../../db/models/shared-artifact.js', () => ({
  createArtifact: vi.fn((d: any) => ({ id: 'art_test', ...d, readableBy: d.readableBy, expiresAt: '2099-01-01', createdAt: '2026-01-01' })),
  getArtifact: vi.fn(() => ({
    id: 'art_test', ownerId: 'dev', name: 'code', content: 'hello',
    readableBy: ['testing', 'code-review'], expiresAt: '2099-01-01', createdAt: '2026-01-01',
  })),
  listArtifacts: vi.fn(() => [
    { id: 'art_1', ownerId: 'dev', name: 'code', content: 'x', readableBy: ['testing'], expiresAt: '2099-01-01', createdAt: '2026-01-01' },
    { id: 'art_2', ownerId: 'qa', name: 'report', content: 'y', readableBy: ['coding'], expiresAt: '2099-01-01', createdAt: '2026-01-01' },
  ]),
  deleteExpiredArtifacts: vi.fn(() => 3),
}));

vi.mock('../capability-registry.js', () => ({}));

describe('SharedArtifactStore', () => {
  let store: SharedArtifactStore;
  const mockRegistry = {
    getAgentCapabilities: vi.fn((id: string) => {
      if (id === 'qa') return ['testing', 'security-scan'];
      if (id === 'dev') return ['coding', 'debugging'];
      return [];
    }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    store = new SharedArtifactStore(mockRegistry as any);
  });

  it('publish creates an artifact', () => {
    const art = store.publish({ ownerId: 'dev', name: 'code', content: 'hello', readableBy: ['testing'] });
    expect(art.id).toBe('art_test');
  });

  it('read allows access when agent has matching capability', () => {
    const content = store.read('art_test', 'qa'); // qa has 'testing'
    expect(content).toBe('hello');
  });

  it('read denies access when agent lacks capability', () => {
    const content = store.read('art_test', 'unknown'); // unknown has no caps
    expect(content).toBeNull();
  });

  it('read allows access to owner', () => {
    const content = store.read('art_test', 'dev'); // dev is owner
    expect(content).toBe('hello');
  });

  it('listAccessible filters by agent capabilities', () => {
    const accessible = store.listAccessible('qa'); // qa has 'testing'
    expect(accessible).toHaveLength(1);
    expect(accessible[0].id).toBe('art_1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/server/src/agents/__tests__/shared-artifact-store.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement SharedArtifactStore**

Create `packages/server/src/agents/shared-artifact-store.ts`:

```typescript
import { createArtifact, getArtifact, listArtifacts, deleteExpiredArtifacts } from '../db/models/shared-artifact.js';
import { eventBus } from '../events/event-bus.js';
import { logger } from '../lib/logger.js';
import type { CapabilityRegistry } from './capability-registry.js';
import type { Artifact } from '../types.js';

export class SharedArtifactStore {
  private registry: CapabilityRegistry;

  constructor(registry: CapabilityRegistry) {
    this.registry = registry;
  }

  /** Publish an artifact with capability-based read access */
  publish(data: {
    ownerId: string;
    name: string;
    content: string;
    readableBy: string[];
    ttlHours?: number;
  }): Artifact {
    const artifact = createArtifact({
      ownerId: data.ownerId,
      name: data.name,
      content: data.content,
      readableBy: data.readableBy,
      ttlHours: data.ttlHours,
    });

    eventBus.emit('artifact:published', { artifact: { ...artifact, content: undefined } });
    logger.info({ artifactId: artifact.id, owner: data.ownerId, name: data.name }, 'Artifact published');
    return artifact;
  }

  /** Read an artifact (checks reader's capabilities) */
  read(artifactId: string, readerId: string): string | null {
    const artifact = getArtifact(artifactId);
    if (!artifact) return null;

    // Owner always has access
    if (artifact.ownerId === readerId) {
      eventBus.emit('artifact:read', { artifactId, readerId, allowed: true });
      return artifact.content;
    }

    // Check capability-based access
    const readerCaps = this.registry.getAgentCapabilities(readerId);
    const hasAccess = artifact.readableBy.some(cap => readerCaps.includes(cap));

    eventBus.emit('artifact:read', { artifactId, readerId, allowed: hasAccess });

    if (!hasAccess) {
      logger.warn({ artifactId, readerId, required: artifact.readableBy, actual: readerCaps }, 'Artifact access denied');
      return null;
    }

    return artifact.content;
  }

  /** List artifacts accessible to an agent */
  listAccessible(agentId: string): Artifact[] {
    const agentCaps = this.registry.getAgentCapabilities(agentId);
    const allArtifacts = listArtifacts();

    return allArtifacts.filter(art => {
      if (art.ownerId === agentId) return true;
      return art.readableBy.some(cap => agentCaps.includes(cap));
    });
  }

  /** Clean up expired artifacts */
  cleanup(): number {
    const deleted = deleteExpiredArtifacts();
    if (deleted > 0) {
      logger.info({ deleted }, 'Expired artifacts cleaned up');
    }
    return deleted;
  }
}
```

- [ ] **Step 4: Create artifact cleanup worker**

Create `packages/server/src/workers/artifact-cleanup.ts`:

```typescript
import type { BackgroundWorker, WorkerContext, WorkerResult } from './scheduler.js';
import { deleteExpiredArtifacts } from '../db/models/shared-artifact.js';

export const artifactCleanupWorker: BackgroundWorker = {
  id: 'artifact-cleanup',
  name: 'Artifact Cleanup',
  intervalMs: 30 * 60 * 1000, // 30 minutes
  enabled: true,

  async run(ctx: WorkerContext): Promise<WorkerResult> {
    const deleted = deleteExpiredArtifacts();
    return {
      success: true,
      message: `Cleaned up ${deleted} expired artifacts`,
    };
  },
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/server/src/agents/__tests__/shared-artifact-store.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/agents/shared-artifact-store.ts packages/server/src/agents/__tests__/shared-artifact-store.test.ts packages/server/src/workers/artifact-cleanup.ts
git commit -m "feat: add shared artifact store with capability-based access control"
```

---

### Task 6: AgentComms

**Files:**
- Create: `packages/server/src/agents/agent-comms.ts`

- [ ] **Step 1: Write the test**

Create `packages/server/src/agents/__tests__/agent-comms.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentComms } from '../agent-comms.js';

vi.mock('../../db/models/agent-comm-log.js', () => ({
  createCommLog: vi.fn((d: any) => ({ id: 'comm_test', ...d, status: 'pending', createdAt: '2026-01-01' })),
  updateCommLog: vi.fn((id: string, u: any) => ({ id, ...u })),
  getCommLog: vi.fn(() => ({ id: 'comm_test', status: 'done' })),
}));
vi.mock('../../events/event-bus.js', () => ({
  eventBus: { emit: vi.fn(), on: vi.fn() },
}));

describe('AgentComms', () => {
  let comms: AgentComms;
  const mockRegistry = {
    findProvider: vi.fn(),
    getAgentCapabilities: vi.fn(() => []),
  };
  const mockRuntime = {
    execute: vi.fn(),
  };
  const mockTaskQueue = {
    enqueue: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    comms = new AgentComms(mockRegistry as any, mockRuntime as any, mockTaskQueue as any);
  });

  it('request throws when no provider found', async () => {
    mockRegistry.findProvider.mockReturnValue(undefined);
    await expect(comms.request({
      from: 'dev',
      capability: 'nonexistent',
      payload: {},
    })).rejects.toThrow('No available agent providing capability: nonexistent');
  });

  it('request calls runtime.execute for sync mode', async () => {
    mockRegistry.findProvider.mockReturnValue({ id: 'review', name: 'Reviewer' });
    mockRuntime.execute.mockResolvedValue({ output: 'LGTM', durationMs: 1000 });

    const result = await comms.request({
      from: 'dev',
      capability: 'code-review',
      payload: { code: 'hello()' },
    });

    expect(result.success).toBe(true);
    expect(result.providerId).toBe('review');
    expect(result.output).toBe('LGTM');
  });

  it('send creates a task for async mode', async () => {
    mockRegistry.findProvider.mockReturnValue({ id: 'qa', name: 'QA' });
    mockTaskQueue.enqueue.mockResolvedValue({ id: 'task_async' });

    const messageId = await comms.send({
      from: 'dev',
      capability: 'testing',
      payload: { workspace: '/path' },
    });

    expect(messageId).toBe('comm_test');
    expect(mockTaskQueue.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'direct',
      assigneeId: 'qa',
    }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/server/src/agents/__tests__/agent-comms.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement AgentComms**

Create `packages/server/src/agents/agent-comms.ts`:

```typescript
import { eventBus } from '../events/event-bus.js';
import { createCommLog, updateCommLog, getCommLog } from '../db/models/agent-comm-log.js';
import { logger } from '../lib/logger.js';
import type { CapabilityRegistry } from './capability-registry.js';
import type { AgentRuntime } from './agent-runtime.js';
import type { TaskQueue } from '../queue/task-queue.js';
import type { CommRequest, CommMessage, CommResponse, CommMessageRecord } from '../types.js';

export class AgentComms {
  private registry: CapabilityRegistry;
  private runtime: AgentRuntime;
  private taskQueue: TaskQueue;

  constructor(registry: CapabilityRegistry, runtime: AgentRuntime, taskQueue: TaskQueue) {
    this.registry = registry;
    this.runtime = runtime;
    this.taskQueue = taskQueue;

    // Listen for async task completions
    eventBus.on('task:done', (event) => {
      const { taskId } = event.payload as { taskId: string };
      this.onAsyncTaskDone(taskId);
    });
  }

  /** Synchronous request: find provider, execute, wait */
  async request(req: CommRequest): Promise<CommResponse> {
    const provider = this.registry.findProvider(req.capability);
    if (!provider) {
      throw new Error(`No available agent providing capability: ${req.capability}`);
    }

    const log = createCommLog({
      fromAgentId: req.from,
      toAgentId: provider.id,
      capability: req.capability,
      mode: 'sync',
      payloadSummary: JSON.stringify(req.payload).slice(0, 500),
    });

    updateCommLog(log.id, { status: 'running' });
    eventBus.emit('agent:comm:request', { commId: log.id, from: req.from, to: provider.id, capability: req.capability });

    const startTime = Date.now();
    const timeout = req.timeout || 60000;

    try {
      const taskInput = typeof req.payload === 'string' ? req.payload : JSON.stringify(req.payload);

      const resultPromise = this.runtime.execute(provider, {
        id: `comm_task_${log.id}`,
        title: `[Comm] ${req.capability} from ${req.from}`,
        description: taskInput,
        input: taskInput,
        mode: 'direct' as any,
        status: 'running' as any,
        priority: 'normal' as any,
        assigneeId: provider.id,
        createdBy: 'master' as any,
        dependsOn: [],
        retryCount: 0,
        maxRetries: 0,
        createdAt: new Date().toISOString(),
      } as any);

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Timeout')), timeout)
      );

      const result = await Promise.race([resultPromise, timeoutPromise]);
      const durationMs = Date.now() - startTime;

      updateCommLog(log.id, {
        status: 'done',
        outputSummary: result.output.slice(0, 500),
        durationMs,
        completedAt: new Date().toISOString(),
      });

      const response: CommResponse = {
        success: true,
        providerId: provider.id,
        output: result.output,
        durationMs,
      };

      eventBus.emit('agent:comm:response', { commId: log.id, response });
      logger.info({ commId: log.id, from: req.from, to: provider.id, capability: req.capability, durationMs }, 'Sync comm completed');

      return response;
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      const status = err.message === 'Timeout' ? 'timeout' : 'failed';

      updateCommLog(log.id, {
        status,
        outputSummary: err.message,
        durationMs,
        completedAt: new Date().toISOString(),
      });

      logger.warn({ commId: log.id, error: err.message, status }, 'Sync comm failed');

      return {
        success: false,
        providerId: provider.id,
        output: err.message,
        durationMs,
      };
    }
  }

  /** Asynchronous message: create task, return immediately */
  async send(msg: CommMessage): Promise<string> {
    const provider = this.registry.findProvider(msg.capability);
    if (!provider) {
      throw new Error(`No available agent providing capability: ${msg.capability}`);
    }

    const log = createCommLog({
      fromAgentId: msg.from,
      toAgentId: provider.id,
      capability: msg.capability,
      mode: 'async',
      payloadSummary: JSON.stringify(msg.payload).slice(0, 500),
    });

    const taskInput = typeof msg.payload === 'string' ? msg.payload : JSON.stringify(msg.payload);

    const task = await this.taskQueue.enqueue({
      title: `[Async Comm] ${msg.capability} from ${msg.from}`,
      description: taskInput,
      input: taskInput,
      mode: 'direct',
      assigneeId: provider.id,
    });

    updateCommLog(log.id, { status: 'running', taskId: task.id });

    eventBus.emit('agent:comm:message', { commId: log.id, from: msg.from, to: provider.id, capability: msg.capability, taskId: task.id });
    logger.info({ commId: log.id, taskId: task.id, from: msg.from, to: provider.id }, 'Async comm dispatched');

    return log.id;
  }

  /** Get status of an async message */
  getMessageStatus(messageId: string): CommMessageRecord | undefined {
    return getCommLog(messageId);
  }

  /** Handle async task completion — update comm log and notify sender */
  private onAsyncTaskDone(taskId: string): void {
    // Find comm log entries linked to this task
    const { listCommLogs } = require('../db/models/agent-comm-log.js');
    const logs = listCommLogs({ status: 'running' }) as CommMessageRecord[];
    const log = logs.find(l => l.taskId === taskId);
    if (!log) return;

    updateCommLog(log.id, {
      status: 'done',
      completedAt: new Date().toISOString(),
    });

    eventBus.emit('agent:comm:response', { commId: log.id, taskId });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/server/src/agents/__tests__/agent-comms.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/agents/agent-comms.ts packages/server/src/agents/__tests__/agent-comms.test.ts
git commit -m "feat: add AgentComms for sync/async inter-agent communication"
```

---

### Task 7: API Routes

**Files:**
- Create: `packages/server/src/routes/capabilities.ts`
- Create: `packages/server/src/routes/agent-comms.ts`
- Create: `packages/server/src/routes/artifacts.ts`
- Modify: `packages/server/src/index.ts`

- [ ] **Step 1: Create capabilities routes**

Create `packages/server/src/routes/capabilities.ts`:

```typescript
import { Router } from 'express';
import type { CapabilityRegistry } from '../agents/capability-registry.js';

export function createCapabilityRoutes(registry: CapabilityRegistry): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json(registry.listCapabilities());
  });

  router.get('/:name/providers', (req, res) => {
    const providers = registry.findAllProviders(req.params.name);
    res.json({
      capability: req.params.name,
      providers: providers.map(p => ({ id: p.id, name: p.name, role: p.role })),
    });
  });

  return router;
}
```

- [ ] **Step 2: Create agent-comms routes**

Create `packages/server/src/routes/agent-comms.ts`:

```typescript
import { Router } from 'express';
import type { AgentComms } from '../agents/agent-comms.js';
import { listCommLogs } from '../db/models/agent-comm-log.js';

export function createAgentCommsRoutes(agentComms: AgentComms): Router {
  const router = Router();

  router.post('/request', async (req, res) => {
    try {
      const { from, capability, payload, timeout } = req.body;
      if (!from || !capability) {
        return res.status(400).json({ error: 'from and capability are required' });
      }
      const result = await agentComms.request({ from, capability, payload, timeout });
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/send', async (req, res) => {
    try {
      const { from, capability, payload, replyTo } = req.body;
      if (!from || !capability) {
        return res.status(400).json({ error: 'from and capability are required' });
      }
      const messageId = await agentComms.send({ from, capability, payload, replyTo });
      res.status(201).json({ messageId });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/log', (req, res) => {
    const logs = listCommLogs({
      capability: req.query.capability as string,
      fromAgentId: req.query.from as string,
      toAgentId: req.query.to as string,
      limit: parseInt(req.query.limit as string) || 50,
    });
    res.json(logs);
  });

  router.get('/:id', (req, res) => {
    const status = agentComms.getMessageStatus(req.params.id);
    if (!status) return res.status(404).json({ error: 'Message not found' });
    res.json(status);
  });

  return router;
}
```

- [ ] **Step 3: Create artifacts routes**

Create `packages/server/src/routes/artifacts.ts`:

```typescript
import { Router } from 'express';
import type { SharedArtifactStore } from '../agents/shared-artifact-store.js';
import { listArtifacts, getArtifact } from '../db/models/shared-artifact.js';

export function createArtifactRoutes(store: SharedArtifactStore): Router {
  const router = Router();

  router.post('/', (req, res) => {
    try {
      const { ownerId, name, content, readableBy, ttlHours } = req.body;
      if (!ownerId || !name || !content) {
        return res.status(400).json({ error: 'ownerId, name, and content are required' });
      }
      const artifact = store.publish({ ownerId, name, content, readableBy: readableBy || [], ttlHours });
      res.status(201).json({ ...artifact, content: undefined });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/', (req, res) => {
    const agentId = req.query.agentId as string;
    if (agentId) {
      const accessible = store.listAccessible(agentId);
      res.json(accessible.map(a => ({ ...a, content: undefined })));
    } else {
      const all = listArtifacts({ limit: parseInt(req.query.limit as string) || 50 });
      res.json(all.map(a => ({ ...a, content: undefined })));
    }
  });

  router.get('/:id', (req, res) => {
    const agentId = req.query.agentId as string;
    if (!agentId) {
      const art = getArtifact(req.params.id);
      if (!art) return res.status(404).json({ error: 'Artifact not found' });
      return res.json(art);
    }
    const content = store.read(req.params.id, agentId);
    if (content === null) {
      return res.status(403).json({ error: 'Access denied or artifact not found' });
    }
    const art = getArtifact(req.params.id)!;
    res.json({ ...art, content });
  });

  return router;
}
```

- [ ] **Step 4: Register everything in index.ts**

In `packages/server/src/index.ts`, add imports:

```typescript
import { CapabilityRegistry } from './agents/capability-registry.js';
import { AgentComms } from './agents/agent-comms.js';
import { SharedArtifactStore } from './agents/shared-artifact-store.js';
import { createCapabilityRoutes } from './routes/capabilities.js';
import { createAgentCommsRoutes } from './routes/agent-comms.js';
import { createArtifactRoutes } from './routes/artifacts.js';
import { artifactCleanupWorker } from './workers/artifact-cleanup.js';
```

After `agentManager.initializeFromRegistry()`, add:

```typescript
  // Initialize capability registry
  const capabilityRegistry = new CapabilityRegistry();
  capabilityRegistry.buildIndex();
  logger.info('Capability registry built');
```

After TaskQueue and PipelineEngine initialization, add:

```typescript
  // Initialize agent communications
  const agentComms = new AgentComms(capabilityRegistry, agentRuntime, taskQueue);
  const artifactStore = new SharedArtifactStore(capabilityRegistry);
  logger.info('Agent federation protocol active');
```

Add routes (near other `/api/v1/` routes):

```typescript
  app.use('/api/v1/capabilities', createCapabilityRoutes(capabilityRegistry));
  app.use('/api/v1/agent-comms', createAgentCommsRoutes(agentComms));
  app.use('/api/v1/artifacts', createArtifactRoutes(artifactStore));
```

Register the cleanup worker (find where WorkerScheduler is used, or register alongside existing workers):

```typescript
  // Register artifact cleanup worker if WorkerScheduler exists, otherwise use setInterval
  setInterval(() => artifactCleanupWorker.run({ logger, emit: (t, p) => eventBus.emit(t as any, p) }), artifactCleanupWorker.intervalMs);
```

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/routes/capabilities.ts packages/server/src/routes/agent-comms.ts packages/server/src/routes/artifacts.ts packages/server/src/index.ts
git commit -m "feat: add federation API routes and wire up modules"
```

---

### Task 8: Integration smoke test

**Files:**
- Create: `packages/server/src/__tests__/batch-c-integration.test.ts`

- [ ] **Step 1: Write integration test**

Create `packages/server/src/__tests__/batch-c-integration.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';

vi.mock('../events/event-bus.js', () => ({
  eventBus: { emit: vi.fn(), on: vi.fn() },
}));
vi.mock('../db/models/agent.js', () => ({
  listAgents: vi.fn(() => [
    { id: 'dev', capabilities: ['coding'], config: { maxConcurrent: 1 } },
    { id: 'qa', capabilities: ['testing'], config: { maxConcurrent: 1 } },
  ]),
}));
vi.mock('../db/models/execution.js', () => ({
  getActiveExecutionCount: vi.fn(() => 0),
}));

describe('Batch C integration', () => {
  it('CapabilityRegistry builds index and finds providers', async () => {
    const { CapabilityRegistry } = await import('../agents/capability-registry.js');
    const registry = new CapabilityRegistry();
    registry.buildIndex();

    expect(registry.findProvider('coding')?.id).toBe('dev');
    expect(registry.findProvider('testing')?.id).toBe('qa');
    expect(registry.findProvider('nonexistent')).toBeUndefined();
    expect(registry.listCapabilities()).toHaveLength(2);
  });

  it('SharedArtifactStore enforces capability-based access', async () => {
    vi.doMock('../db/models/shared-artifact.js', () => ({
      createArtifact: vi.fn((d: any) => ({ id: 'art_1', ...d, readableBy: d.readableBy, expiresAt: '2099-01-01', createdAt: '2026-01-01' })),
      getArtifact: vi.fn(() => ({ id: 'art_1', ownerId: 'dev', name: 'code', content: 'hello', readableBy: ['testing'], expiresAt: '2099-01-01', createdAt: '2026-01-01' })),
      listArtifacts: vi.fn(() => []),
      deleteExpiredArtifacts: vi.fn(() => 0),
    }));

    const { CapabilityRegistry } = await import('../agents/capability-registry.js');
    const registry = new CapabilityRegistry();
    registry.buildIndex();

    const { SharedArtifactStore } = await import('../agents/shared-artifact-store.js');
    const store = new SharedArtifactStore(registry);

    // qa has 'testing' → can read
    const content = store.read('art_1', 'qa');
    expect(content).toBe('hello');

    // dev is owner → can read
    const ownerContent = store.read('art_1', 'dev');
    expect(ownerContent).toBe('hello');
  });
});
```

- [ ] **Step 2: Commit**

```bash
git add packages/server/src/__tests__/batch-c-integration.test.ts
git commit -m "test: add Batch C federation protocol integration tests"
```
