# Workspace completion V2 acceptance

Date: 2026-10-12 (Asia/Shanghai).

Implemented: Git/non-Git reviewed additions, modifications and deletions;
hash-verified frozen non-Git baseline manifests; sealed deletion evidence;
pre-apply backups and rollback/reconciliation; selected dirty-source deletions;
explicit legacy adoption as non-purgeable user source; purged owned branch
cleanup with merge/check-out checks; corresponding UI and CI gates.

Local evidence:

- Server full: 1,051 passed / 6 skipped; 153 files passed / 2 skipped.
  Five skipped cases need Redis, one opt-in live clone was run separately.
- Dashboard: 225 passed, 19 files.
- Focused workspace: 21 passed.
- Browser: 9 passed, including legacy adoption and retained historical downloads.
- Shared/server/dashboard/desktop build, lint, contracts and pipeline validation:
  passed. Legacy contract inference warnings remain.
- Live public HTTPS clone: 1 passed using actual scoped HTTP route and Git
  transport to `octocat/Hello-World`.
- Live configured model: response `MYRMECIA_LIVE_OK`, provider `copilot`,
  actual model `gpt-5.4-mini`; one tool-free minimal request, not a benchmark.
- Live Codex CLI adapter: succeeded and reported its assigned temporary directory.
  This is a cwd report, not a universal external execution sandbox guarantee.
- Desktop staging: passed. macOS ARM64 unsigned app and DMG built; workspace
  modules were found inside packaged server resources. Signing/notarization
  skipped due to absent release credentials. No Windows/Linux packaging claimed.

Remaining environment gates:

- Existing MCP list is empty and Xiaohongshu status is `unavailable`.
  No login/credential switch was attempted.
- Docker daemon is stopped; actual Docker isolation/Redis restart cannot run
  locally. CI uses the dedicated labeled loopback Redis container and performs
  the actual restart test. Its outcome must be observed separately after push.
- PostgreSQL compatibility remains its own architectural migration; SQLite is
  the supported backend. It is not enabled by this feature.
- General OS isolation across Host Shell, remote Agents and MCP is not claimed.

Temporary command logs are under `/tmp/myrmecia-workspace-v2-*.log`. Persistent
browser output is `artifacts/workspace-lifecycle/browser-e2e.json` plus screenshots.
Raw logs, installation trees, account state, model outputs beyond the acceptance
marker, source clone bytes and database files are excluded from publication.

Publication is a new `codex/workspace-completion-*` branch to
`Zchary1106/Myrmecia`. No force push or main merge is authorized. Existing local
runtime/governance/setup/CrewAI-removal source dependencies are included so the
published checkout is buildable; unrelated private runtime artifacts stay local.

Publication verified: implementation commit
`7aa28eabce0f1435a7e3b80762977c9ca42d55ee` is on
`origin/codex/workspace-completion-20261012`. Account: Zchary1106.
CI run `38160332768` began and was still in progress at the read-only check;
remote success is not claimed. No PR was created and main was not merged.
Final post-checkpoint targeted regression: 28 tests passed. This includes the
last artifact-indexer deletion fix; earlier full-suite counts are from the
preceding complete local run, not a re-run after the one-line test formatting fix.
