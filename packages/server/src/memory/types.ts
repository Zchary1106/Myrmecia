/**
 * Unified Memory — Core Types
 *
 * A single substrate for the four memory layers described in
 * docs/MEMORY-ARCHITECTURE.md:
 *   - working    : ephemeral, single-execution context
 *   - episodic   : one record per task execution (input + outcome)
 *   - semantic   : facts / conventions / user preferences / docs
 *   - procedural : "how to do X" — routing experience, recipes, lessons
 */

export type MemoryType = 'working' | 'episodic' | 'semantic' | 'procedural' | 'entity';

export const MEMORY_TYPES: readonly MemoryType[] = [
  'working',
  'episodic',
  'semantic',
  'procedural',
  'entity',
] as const;

/**
 * Namespace a memory belongs to. Every field is optional; an unset field means
 * "not scoped to this dimension" (i.e. global on that axis).
 */
export interface MemoryScope {
  org?: string;
  workspace?: string;
  user?: string;
  agent?: string;
  session?: string;
  pipeline?: string;
}

export const MEMORY_SCOPE_KEYS: readonly (keyof MemoryScope)[] = [
  'org',
  'workspace',
  'user',
  'agent',
  'session',
  'pipeline',
] as const;

export interface MemoryItem {
  id: string;
  type: MemoryType;
  scope: MemoryScope;
  content: string;
  summary?: string;
  embedding?: number[];
  /** 0..1 — how central this memory is */
  importance: number;
  /** 0..1 — historical success (episodic/procedural) */
  success?: number;
  /** 0..1 — outcome quality (episodic/procedural) */
  quality?: number;
  sourceType?: string;
  sourceId?: string;
  createdAt: string;
  lastAccessedAt?: string;
  accessCount: number;
  validFrom?: string;
  validTo?: string;
  expiresAt?: string;
  metadata: Record<string, unknown>;
}

export interface MemoryWriteInput {
  type: MemoryType;
  content: string;
  scope?: MemoryScope;
  summary?: string;
  importance?: number;
  success?: number;
  quality?: number;
  sourceType?: string;
  sourceId?: string;
  validFrom?: string;
  validTo?: string;
  expiresAt?: string;
  metadata?: Record<string, unknown>;
  /** Pre-computed embedding (skips the embedding service when provided) */
  embedding?: number[];
}

export interface ScoreWeights {
  relevance: number;
  recency: number;
  importance: number;
  success: number;
}

export interface MemoryQuery {
  query: string;
  types?: MemoryType[];
  /** Only items whose own scope is compatible with this scope are returned. */
  scope?: MemoryScope;
  topK?: number;
  minScore?: number;
  recencyTauDays?: number;
  weights?: Partial<ScoreWeights>;
  /** MMR diversity tradeoff (1 = pure relevance, 0 = pure diversity). Default 0.7 */
  mmrLambda?: number;
  includeExpired?: boolean;
}

export interface ScoredMemory {
  item: MemoryItem;
  /** Final hybrid score */
  score: number;
  /** Cosine relevance component (0..1) */
  relevance: number;
}

export interface MemoryStore {
  initialize(): Promise<void>;
  add(input: MemoryWriteInput): Promise<MemoryItem>;
  get(id: string): MemoryItem | undefined;
  recall(query: MemoryQuery): Promise<ScoredMemory[]>;
  forget(id: string): void;
  touch(id: string): void;
  size(type?: MemoryType): number;
  persist(): void;
}
