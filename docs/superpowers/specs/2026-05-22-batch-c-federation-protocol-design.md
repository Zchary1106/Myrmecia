# Batch C: Agent Federation Protocol — Design Spec

## Overview

A capability-based inter-agent communication system enabling agents to discover each other by capability, exchange messages (sync and async), and share intermediate artifacts with access control. All communication is within a single Agent Factory instance — no cross-machine networking.

```
Agent A → AgentComms.request("code-review", payload)
       → CapabilityRegistry finds provider
       → sync: AgentRuntime.execute() + wait
       → async: create Task + EventBus callback

Agent A → SharedArtifactStore.publish(artifact, readableBy: ["testing"])
Agent B → SharedArtifactStore.read(artifactId) → allowed if B has "testing" capability
```

---

## 1. Capability Registry

### Purpose

Maps capabilities to agents so agents can discover each other without knowing specific Agent IDs. Uses the existing `capabilities` field in `agents/registry.yaml` which is already synced to DB but currently unused.

### Interface

```typescript
class CapabilityRegistry {
  /** Build capability→agents index from DB */
  buildIndex(): void

  /** Find one available agent providing a capability (checks capacity) */
  findProvider(capability: string): AgentDefinition | undefined

  /** Find all agents providing a capability */
  findAllProviders(capability: string): AgentDefinition[]

  /** Refresh index (called on agent:status events) */
  refresh(): void
}
```

### Behavior

- Built at startup from `listAgents()`, reading each agent's `capabilities` array
- Auto-refreshes when `agent:status` events fire (agent registered/updated)
- `findProvider` checks concurrency capacity via `getActiveExecutionCount`, returns first available agent with the requested capability
- If multiple providers exist, uses the agent's `routeWeight` (from Batch A scoring) for weighted selection

### Implementation

- New file: `packages/server/src/agents/capability-registry.ts`
- No new DB tables — reads from existing `agents` table `capabilities` column

---

## 2. Agent Communications (AgentComms)

### Purpose

Provides two communication modes between agents: synchronous request/response and asynchronous messaging.

### Interface

```typescript
interface CommRequest {
  from: string;          // sender agent ID
  capability: string;    // what capability is needed
  payload: any;          // input data
  timeout?: number;      // ms, default 60000
}

interface CommMessage {
  from: string;
  capability: string;
  payload: any;
  replyTo?: string;      // agent ID to notify on completion
}

interface CommResponse {
  success: boolean;
  providerId: string;    // which agent handled it
  output: any;
  durationMs: number;
}

class AgentComms {
  constructor(
    capabilityRegistry: CapabilityRegistry,
    agentRuntime: AgentRuntime,
    taskQueue: TaskQueue
  )

  /** Synchronous: find provider, execute, wait for result */
  async request(req: CommRequest): Promise<CommResponse>

  /** Asynchronous: find provider, create task, return message ID */
  async send(msg: CommMessage): Promise<string>

  /** Get status of an async message */
  getMessageStatus(messageId: string): CommMessageRecord | undefined
}
```

### Synchronous Flow

1. `request()` called by Agent A
2. CapabilityRegistry finds available provider for the capability
3. If no provider → throw error with capability name
4. Create a direct task for the provider with the payload as input
5. Call `agentRuntime.execute()` and await result
6. Return CommResponse with output
7. If timeout exceeded → cancel execution, return error
8. Record in `agent_comm_log` table for audit

### Asynchronous Flow

1. `send()` called by Agent A
2. CapabilityRegistry finds provider
3. Create a task via TaskQueue (mode: 'direct', assignee: provider)
4. Store message record in `agent_comm_log` with status 'pending'
5. Return message ID immediately
6. When task completes → EventBus `task:done` handler updates message status
7. If `replyTo` is set → emit `agent:message` event so sender can react

### Data Model

```sql
CREATE TABLE IF NOT EXISTS agent_comm_log (
  id TEXT PRIMARY KEY,
  from_agent_id TEXT NOT NULL,
  to_agent_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('sync', 'async')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'done', 'failed', 'timeout')),
  payload_summary TEXT,        -- first 500 chars of payload for audit
  task_id TEXT,                -- linked task (async mode)
  output_summary TEXT,         -- first 500 chars of output
  duration_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);
```

### Implementation

- New file: `packages/server/src/agents/agent-comms.ts`
- New file: `packages/server/src/db/models/agent-comm-log.ts`
- Modify: `packages/server/src/db/database.ts` (add schema)

---

## 3. Shared Artifact Store

### Purpose

Allows agents to publish intermediate work products and share them with other agents based on capability-based access control.

### Interface

```typescript
interface Artifact {
  id: string;
  ownerId: string;
  name: string;
  content: string;
  readableBy: string[];    // capabilities required to read
  expiresAt: string;
  createdAt: string;
}

class SharedArtifactStore {
  /** Publish an artifact with capability-based read access */
  publish(data: {
    ownerId: string;
    name: string;
    content: string;
    readableBy: string[];
  }): Artifact

  /** Read an artifact (checks reader's capabilities against readableBy) */
  read(artifactId: string, readerId: string): string | null

  /** List artifacts accessible to an agent (based on its capabilities) */
  listAccessible(agentId: string): Artifact[]

  /** Delete expired artifacts (default TTL: 24h) */
  cleanup(): void
}
```

### Access Control

1. Agent A publishes artifact with `readableBy: ['testing', 'code-review']`
2. Agent B requests read → system checks B's capabilities from CapabilityRegistry
3. If B has any capability in the `readableBy` list → access granted
4. Otherwise → null returned (access denied)
5. The artifact owner always has read access regardless of capabilities

### Cleanup

- Artifacts expire after 24 hours by default
- Cleanup runs as a background worker via existing WorkerScheduler (every 30 minutes)
- Expired artifacts are deleted from DB

### Data Model

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

### Implementation

- New file: `packages/server/src/agents/shared-artifact-store.ts`
- New file: `packages/server/src/db/models/shared-artifact.ts`
- New file: `packages/server/src/workers/artifact-cleanup.ts`
- Modify: `packages/server/src/db/database.ts` (add schema)

---

## 4. API Endpoints

Expose federation features via REST for Dashboard visibility and manual testing.

```
GET  /api/v1/capabilities                    → list all capabilities and their providers
GET  /api/v1/capabilities/:name/providers    → agents providing a specific capability

POST /api/v1/agent-comms/request             → trigger sync request between agents
POST /api/v1/agent-comms/send                → trigger async message
GET  /api/v1/agent-comms/log                 → audit log of agent communications

POST /api/v1/artifacts                       → publish an artifact
GET  /api/v1/artifacts/:id                   → read an artifact (requires agent context)
GET  /api/v1/artifacts                       → list artifacts
```

### Implementation

- New file: `packages/server/src/routes/capabilities.ts`
- New file: `packages/server/src/routes/agent-comms.ts`
- New file: `packages/server/src/routes/artifacts.ts`
- Modify: `packages/server/src/index.ts` (mount routes, register modules)

---

## File Changes Summary

### New Files

| File | Purpose |
|------|---------|
| `packages/server/src/agents/capability-registry.ts` | Capability→Agent mapping and discovery |
| `packages/server/src/agents/agent-comms.ts` | Sync/async inter-agent communication |
| `packages/server/src/agents/shared-artifact-store.ts` | Artifact publishing with access control |
| `packages/server/src/db/models/agent-comm-log.ts` | Communication audit log model |
| `packages/server/src/db/models/shared-artifact.ts` | Shared artifact model |
| `packages/server/src/workers/artifact-cleanup.ts` | Expired artifact cleanup worker |
| `packages/server/src/routes/capabilities.ts` | Capability discovery API |
| `packages/server/src/routes/agent-comms.ts` | Agent communication API |
| `packages/server/src/routes/artifacts.ts` | Artifact management API |

### Modified Files

| File | Changes |
|------|---------|
| `packages/server/src/db/database.ts` | Add agent_comm_log and shared_artifacts schemas |
| `packages/server/src/index.ts` | Register CapabilityRegistry, AgentComms, SharedArtifactStore, mount routes, register cleanup worker |
| `packages/shared/src/index.ts` | Add Artifact, CommRequest, CommResponse types |
