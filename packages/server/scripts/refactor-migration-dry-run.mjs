#!/usr/bin/env node
/**
 * T21 — Agent / Skill / Domain / Team 重构迁移 dry-run。
 *
 * 只读扫描，不写库、不改数据。报告：
 *   1. Legacy Agent 在 tasks / pipelines / execution_ledger 中的引用
 *   2. team_definitions 的 Contract v1/v2 迁移状态（对比 agents/teams.yaml）
 *   3. domain_packs 版本化状态与 tasks.domain_id 引用
 *   4. Execution Ledger 中 plan.snapshot（v2 运行）数量
 *
 * 用法：
 *   node scripts/refactor-migration-dry-run.mjs
 *   DB_PATH=/path/to.db node scripts/refactor-migration-dry-run.mjs --out /tmp/impact.json
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import Database from 'better-sqlite3';

const root = resolve(import.meta.dirname, '../../..');
const outArg = process.argv.indexOf('--out');
const outPath = outArg >= 0 ? process.argv[outArg + 1] : null;

function candidateDbPaths() {
  const env = process.env.DB_PATH || process.env.AGENT_FACTORY_TEST_DB_PATH;
  if (env) return [resolve(root, env)];
  return [
    resolve(root, 'agent-factory.db'),
    resolve(root, 'data/agent-factory.db'),
    resolve(root, 'packages/server/agent-factory.db'),
  ].filter(existsSync);
}

function readYaml(relativePath) {
  try {
    return parseYaml(readFileSync(resolve(root, relativePath), 'utf8'));
  } catch (error) {
    console.error(`  ⚠ cannot read ${relativePath}: ${error.message}`);
    return null;
  }
}

const dbPath = candidateDbPaths()[0];
if (!dbPath) {
  console.log('No SQLite database found (set DB_PATH or run once first). Nothing to scan.');
  process.exit(0);
}

console.log(`Scanning database: ${dbPath}\n`);
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const report = { dbPath, scannedAt: new Date().toISOString(), sections: {} };

function jsonColumn(row) {
  if (row == null) return [];
  try { return JSON.parse(row); } catch { return []; }
}

// 1. Legacy aliases
const aliasesYaml = readYaml('agents/legacy-agent-aliases.yaml');
const legacyIds = new Set();
for (const entry of Object.entries(aliasesYaml?.legacyAgentAliases ?? {})) {
  legacyIds.add(entry[0]);
}
report.sections.legacyAliases = { count: legacyIds.size };

// 2. Tasks referencing legacy agents
const legacyTasks = (() => {
  try {
    const rows = db.prepare(
      'SELECT assignee_id, COUNT(*) AS n FROM tasks WHERE assignee_id IS NOT NULL GROUP BY assignee_id',
    ).all();
    const matches = rows.filter(row => legacyIds.has(row.assignee_id));
    return {
      count: matches.reduce((sum, row) => sum + row.n, 0),
      byAgent: Object.fromEntries(matches.map(row => [row.assignee_id, row.n])),
    };
  } catch { return { count: 0, byAgent: {} }; }
})();
report.sections.tasks = legacyTasks;

// 3. Pipelines whose stages reference legacy agents
const legacyPipelines = (() => {
  try {
    const rows = db.prepare('SELECT id, name, template_id, stages FROM pipelines').all();
    const byId = {};
    let count = 0;
    for (const row of rows) {
      const stages = jsonColumn(row.stages);
      const roles = stages.map(stage => String(stage.agentRole ?? '')).filter(Boolean);
      const legacyRoles = roles.filter(role => legacyIds.has(role));
      if (legacyRoles.length > 0) {
        count += 1;
        byId[row.id] = { name: row.name, templateId: row.template_id, legacyRoles };
      }
    }
    return { count, pipelines: byId };
  } catch { return { count: 0, pipelines: {} }; }
})();
report.sections.pipelines = legacyPipelines;

// 4. Team definitions migration status
const teamStatus = (() => {
  try {
    const teams = db.prepare('SELECT id, name, contract_version, roles FROM team_definitions').all();
    const v1 = teams.filter(team => (team.contract_version ?? 1) !== 2 || !jsonColumn(team.roles).length);
    const v2 = teams.filter(team => (team.contract_version ?? 1) === 2 && jsonColumn(team.roles).length > 0);
    return { v1Count: v1.length, v2Count: v2.length, v1Teams: v1.map(team => team.id) };
  } catch { return { v1Count: 0, v2Count: 0, v1Teams: [] }; }
})();
report.sections.teams = teamStatus;

// 5. Built-in teams.yaml v2 coverage
const teamsYaml = readYaml('agents/teams.yaml');
const yamlTeams = teamsYaml?.teams ?? [];
report.sections.builtinTeams = {
  total: yamlTeams.length,
  v2: yamlTeams.filter(team => team.contractVersion === 2 || team.roles?.length).map(team => team.id),
  v1: yamlTeams.filter(team => !(team.contractVersion === 2 || team.roles?.length)).map(team => team.id),
};

// 6. Domain packs versioning + task domain references
const domainStatus = (() => {
  try {
    const domains = db.prepare('SELECT id, name, version, version_note FROM domain_packs').all();
    const unversioned = domains.filter(domain => !domain.version || domain.version < 1);
    const taskRefs = db.prepare('SELECT domain_id, COUNT(*) AS n FROM tasks WHERE domain_id IS NOT NULL GROUP BY domain_id').all();
    return {
      domainCount: domains.length,
      unversioned: unversioned.map(domain => domain.id),
      taskReferences: Object.fromEntries(taskRefs.map(row => [row.domain_id, row.n])),
    };
  } catch { return { domainCount: 0, unversioned: [], taskReferences: {} }; }
})();
report.sections.domains = domainStatus;

// 7. Execution ledger plan.snapshot (v2 immutable plans)
const ledgerStatus = (() => {
  try {
    const total = db.prepare('SELECT COUNT(*) AS n FROM execution_ledger').get().n;
    const snapshots = db.prepare("SELECT COUNT(*) AS n FROM execution_ledger WHERE type = 'plan.snapshot'").get().n;
    return { total, planSnapshots: snapshots };
  } catch { return { total: 0, planSnapshots: 0 }; }
})();
report.sections.executionLedger = ledgerStatus;

db.close();

// Summary
console.log('=== 迁移影响报告 ===');
console.log(`Legacy Agent 引用: tasks=${report.sections.tasks.count}, pipelines=${report.sections.pipelines.count}`);
console.log(`Team v1 待迁移: ${report.sections.teams.v1Count} 个 (${report.sections.teams.v1Teams.join(', ') || '-'})`);
console.log(`Built-in teams.yaml: v2=${report.sections.builtinTeams.v2.length}, v1=${report.sections.builtinTeams.v1.length}`);
console.log(`Domain packs: ${report.sections.domains.domainCount} 个, 未版本化=${report.sections.domains.unversioned.length}`);
console.log(`Execution ledger: 共 ${report.sections.executionLedger.total} 条, plan.snapshot=${report.sections.executionLedger.planSnapshots}`);

if (outPath) {
  writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\n完整报告已写入: ${outPath}`);
}
