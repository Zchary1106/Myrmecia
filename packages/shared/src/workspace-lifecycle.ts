/** Authorization workspace and filesystem workspace are different identities. */
export type WorkspaceAccessMode = 'isolated' | 'shared_readonly' | 'shared_write';
export type WorkspaceSourceKind = 'git' | 'directory' | 'import' | 'empty' | 'legacy';
export type WorkspaceLifecycle = 'active' | 'candidate' | 'archived' | 'purged' | 'reconciliation';
export type ArtifactCaptureState = 'pending' | 'complete' | 'partial' | 'failed' | 'legacy_live';
export interface WorkspaceBaseline {
  head?: string;
  branch?: string;
  provenance: 'head_only' | 'filtered_copy' | 'empty' | 'legacy_recorded' | 'shared_live';
  excluded: string[];
  snapshotId?: string;
}
export interface ManagedWorkspace {
  id: string;
  workspaceId: string;
  actorId: string;
  sourceKind: WorkspaceSourceKind;
  sourcePath?: string;
  canonicalPath: string;
  ownership: 'managed_execution' | 'user_source' | 'managed_import' | 'legacy_unmanaged';
  accessMode: WorkspaceAccessMode;
  baseline: WorkspaceBaseline;
  lifecycle: WorkspaceLifecycle;
  revision: number;
  lastUsedAt: string;
  createdAt: string;
  captureState: ArtifactCaptureState;
}
export interface ExecutionWorkspaceBinding {
  taskId: string;
  workspaceId: string;
  filesystemWorkspaceId: string;
  sourceWorkspaceId?: string;
  executionPath: string;
  accessMode: WorkspaceAccessMode;
  baseline: WorkspaceBaseline;
}
export interface WorkspaceOperationPreview {
  previewId: string;
  operation: 'archive' | 'restore' | 'purge';
  workspace: ManagedWorkspace;
  blockers: string[];
  manifestHash: string;
  expiresAt: string;
  preservesFiles: boolean;
}
