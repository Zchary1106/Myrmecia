# Workspace lifecycle

Implemented scope and acceptance date: **2026-10-12**.

Myrmecia separates task execution, retained output evidence and source integration.
Completing or accepting a task does not authorize a commit, merge, push or deletion.

## Three identities

| Identity | Meaning |
| --- | --- |
| Authorization `workspaceId` | Tenant/RBAC boundary for tasks and artifacts; not a filesystem path |
| Filesystem workspace ID | Registered canonical directory, actor, ownership, baseline and lifecycle |
| Task filesystem binding | Persisted source ID, execution directory, mode and baseline for a task |

Canonical roots record device/inode identity. Changing a registered directory
behind its path requires reconciliation. The server verifies authorization and
the actual root; client-supplied owner/path fields do not grant access.

Imported-source and lifecycle mutations are actor-and-workspace scoped.
Artifact reads use the existing authorization-workspace access contract, with
snapshot scope and integrity checks. An authorized workspace collaborator can
read an artifact; this feature does not introduce per-artifact private sharing.
Production authentication binds identity to the authenticated token/API key,
not `x-user-id` or operator headers. Disabled-auth local development is not a
production identity boundary.

## Selecting a source and mode

The main launcher keeps its existing model, reasoning, knowledge and conversation
controls. Source selection supports folder upload and an allowed HTTPS Git
repository. A browser-selected local folder becomes a server-side import; the
browser does not reveal a usable absolute directory on the server.

| Mode | Execution behavior |
| --- | --- |
| `isolated` | New managed directory; Git source pinned to HEAD or bounded filtered copy; default for new writable top-level tasks |
| `shared_write` | Registered source itself; overlapping/canonical writers serialize |
| `shared_readonly` | Local file read/list only; writes, shell, MCP and opaque/native loops denied |

No selected source means an empty isolated directory, not the server repository.
Git is recognized only if the selected directory has its own Git root. A folder
nested in the service repository cannot borrow the parent's HEAD.

Git preparation creates `codex/task-<task-id>` and a worktree at the selected
HEAD. Known excluded tracked files are sparse-checkout excluded. Git preparation
failure does not silently fall back to an empty folder.

Uncommitted/untracked source changes are excluded in HEAD-only mode and reported.
An explicit dirty-source workflow previews selected files and content hashes,
then creates a filtered HEAD baseline plus the confirmed working-file overlay.
The full filtered baseline must fit copy quotas; large repositories should use
HEAD-only mode. Selected overlays include readable files and explicitly selected
tracked deletions; missing untracked files and excluded credentials are rejected.

Follow-ups and delegated tasks inherit the recorded conversation/parent directory.
Pipeline stages inherit the pipeline binding. Existing legacy tasks retain their
recorded directory, not a freshly guessed path. Model selection remains the
existing Task/Execution contract and is not changed by workspace preparation.

## Directory and storage roots

`MYRMECIA_WORKSPACE_ROOT`, or the server working directory when unset, contains:

```text
.agent-factory/
  workspaces/          managed execution directories and Git worktrees
  imported-workspaces/ retained import sessions and imported sources
  reviewed-sources/    explicitly confirmed dirty-source copies
  workspace-baselines/ bounded frozen non-Git baselines
  operation-backups/   retained pre-apply bytes for reconciliation
  artifact-snapshots/  hashed immutable artifact namespaces
```

`MYRMECIA_ARTIFACT_SNAPSHOT_ROOT` can select separate artifact storage. Moving
these roots is not automatic: preserve registrations/checkpoints and verify
identity before migrating. No global path migration is performed by this change.

## Concurrency and recovery

Persistent leases admit readers/writers across canonical and overlapping roots.
Independent Agents do not get permission to write the same root concurrently
merely because their Agent-level concurrency limits are independent.

Leases have transactional claims and fencing. Release wakes waiting memory-queue
work. Unknown tool/provider outcomes retain an `uncertain` claim; timeout alone
does not prove a process stopped or permit another writer.

To reconcile an uncertain claim:

1. Stop/settle its tasks using the existing task controls.
2. Obtain a fresh lease preview showing exact task/owner/fence identities.
3. Verify external effects have stopped, then explicitly confirm that fact.
4. Release only the unchanged claims listed by that preview.

This workflow does not kill an OS process, replay a write, or infer task success.
Pause/resume verifies the recorded Git checkpoint and retained artifact hashes;
changed HEAD or damaged bytes fail closed.

## Immutable artifacts

Before successful completion/verification, the runtime captures the result and
changed/generated eligible files into a separate snapshot store. Copied source
inputs are excluded from output inventory by a pre-execution stat baseline.

Each sealed artifact has fixed execution identity, SHA-256, size, scope and capture
state. Reads verify the snapshot; they never fall back to a mutable work file if
sealed bytes are missing or damaged. A follow-up overwriting `output/summary.md`
cannot alter a previous execution's download.

Large tool results, context-summary versions and pipeline stage/report envelopes
also use snapshots. Pipeline envelopes are not competing writes into a directory
already leased by a follow-up. Pipeline final report capture precedes its done
event. Manual/legacy stage records without a real execution are not manufactured
into executed evidence.

Failure, cancellation and requests for essential user input retain partial
evidence when capture is possible. A partial artifact is not completed/accepted
work. Required capture failure blocks success. Artifact bytes and execution
directory retention are independent; temporary-artifact cleanup does not remove
execution snapshots.

Legacy artifact references remain labeled mutable/live. They do not become
immutable just because the UI displays them.

### Quotas and exclusions

- Capture/copy: 250 files, depth 8, 20 MiB/file and 100 MiB/execution.
- Metadata discovery: at most 20,000 entries and depth 32. Oversized scans fail or
  report bounded/truncated inventory; reported directory size is not always total.
- Automatic exclusion: `.git`, `node_modules`, `.agent-factory`, build trees,
  `.env*`, known credential/key paths, cookies and database files.
- Symlinked children, traversal escapes and unstable files are rejected.
- Exclusions, partial capture and quota failures are surfaced, not silently
  labeled a complete deliverable.

Exclusions and DLP reduce exposure but cannot identify every secret. Review
source selection and generated artifacts; do not treat this as a secret scanner.

## Lifecycle actions

| Action | Effect |
| --- | --- |
| Candidate marking | Retention worker marks eligibility; no physical deletion |
| Archive | Closes managed writes; keeps the directory/worktree in place |
| Restore | Rechecks identity/baseline/blockers, then reactivates |
| Purge | Explicitly confirmed removal of an owned archived execution directory only |
| Accept output | Existing task decision; neither directory removal nor source integration |
| Apply changes | Separate reviewed file patch to a named destination; no commit/merge/push |

Archive/restore/purge need a fresh server-persisted preview, expected revision,
manifest hash and confirmation. Previews expire after five minutes. Active leases,
unsettled linked tasks and other blockers are checked again before mutation.
Waiting/review tasks are not marked done merely to make a directory removable.

Purge is intentionally conservative: no user source, import or `legacy_unmanaged`
path; only archived, settled managed execution directories with complete verified
retained coverage. Unsnapshotted inputs, excluded files and symlinks block purge.
Dirty Git worktrees are not force-removed. Purge retains the task branch. A separate
maintenance preview may delete a purged owned `codex/task-*` branch only when it
is no longer checked out and has no unmerged commits; no force deletion.
Legacy adoption also has a separate scoped preview: it registers a user source
without moving files or granting purge ownership. Linked unsettled tasks block it.

Operations persist journal states across filesystem/SQLite gaps. A crash can
leave reconciliation required; the server never guesses successful deletion or
blindly replays an operation. Failed/cancelled imports retain bytes and scoped
receipts/candidate manifests; they are not removed implicitly.

## Reviewing and applying changes

The session's execution-directory panel shows source/effective path, baseline,
mode, occupants and capture state. Home contains workspace management with
last-use/size, candidate/archive/restore, purge preview and lease reconciliation.

Change preview names a destination, target branch/HEAD, selected files and diff
hash. Apply supports reviewed Git and bounded non-Git changes. It refuses
a dirty target, changed baseline, missing evidence, unsettled work or active writer.
Each selected changed file must match hash-verified complete snapshot bytes;
post-capture external edits require fresh evidence. Deletions need a sealed
execution tombstone matching the frozen baseline hash.
It claims both roots in deterministic order and rechecks the reviewed manifest.

Non-Git sources capture hash-verified baseline manifests; additions must not
overwrite existing target files. Non-Git application keeps pre-apply byte backups
and attempts rollback on write failure; crash gaps remain journaled for explicit
reconciliation, never replayed blindly. All changes also have a downloadable
patch. No `git add -A`, commit, merge, force removal,
push or PR creation is part of task completion or patch apply.

## API and implementation pointers

- `/api/v1/workspaces`: scoped persistent imports and HTTPS repository clones.
- `/api/v1/managed-workspaces`: list/register, task facts, lifecycle preview/operations,
  changes preview/apply, source snapshots, operation history, lease reconciliation.
- Existing artifact preview/download endpoints serve verified snapshot bytes.
- `workspace/path-policy.ts`, `task-workspace.ts`, `workspace-lease.ts`: preparation
  and supported host-tool boundaries.
- `workspace/workspace-lifecycle.ts`, `workspace-changes.ts`,
  `workspace-reconciliation.ts`: reviewed mutation and recovery.
- `artifacts/artifact-snapshot-store.ts`, `execution-artifact-indexer.ts`: evidence.
- Additive SQLite tables retain imports, registrations, bindings, preparation
  recipes, leases, operation journals and snapshot metadata.

HTTPS clone hosts default to `github.com`, configurable through
`MYRMECIA_GIT_ALLOWED_HOSTS`. Credential URLs, unsafe transports, private DNS
addresses and redirects are rejected; hooks/interactive credentials and LFS
smudge are disabled. Private-repository authentication is not added here.

## Safety boundary and rollback

A server execution directory and path policy are **not an OS sandbox**. Host
Shell can intentionally access other paths. MCP and provider-owned execution may
run elsewhere. Opaque external runtimes do not prove that the assigned directory
is their actual working directory. Existing external-CLI allowed roots may need
explicit setup; this change does not silently widen them.

Keep journals, roots, branches and snapshots when a preparation/capture/apply
operation fails. Disable new management mutations if rollback is needed, retain
safe reads, then reconcile exact approved targets. Do not restore old automatic
deletion/merge behavior, reset the source checkout or replay uncertain writes.

Local acceptance uses scripted providers with actual Core/HTTP/SQLite/filesystem
and browser paths in temporary fixtures. Live provider/MCP, remote Git clone,
Redis restart, PostgreSQL migration, packaging and universal OS isolation are
separate gates, not proven by these fixture tests.

On 2026-10-12, live public HTTPS clone, one configured Copilot model response,
one Codex CLI working-directory report, desktop staging and unsigned macOS
application/DMG packaging were additionally checked. Those checks do not prove
all-provider compatibility, signed release readiness or general external-tool
isolation. MCP currently reports unavailable; Docker/Redis are unavailable on
this host. CI contains a dedicated Redis container restart gate.
