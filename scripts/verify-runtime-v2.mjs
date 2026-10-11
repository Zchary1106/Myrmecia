import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const output = join(root, 'artifacts/agent-runtime-v2');
mkdirSync(output, { recursive: true });
const mode = process.argv[2] || 'baseline';
if (!['baseline', 'final'].includes(mode) && !/^phase[0-7]$/.test(mode)) throw new Error('Use baseline, phase0..phase7, or final');
if (existsSync(join(output, `${mode}.json`))) {
  const prior = JSON.parse(readFileSync(join(output, `${mode}.json`), 'utf8'));
  const archive = join(output, `${mode}-${String(prior.startedAt).replace(/[^0-9TZ]/g, '')}`);
  mkdirSync(archive, { recursive: true });
  const names = [`${mode}.json`, `${mode}.md`, ...(prior.verification || []).map(item => item.logfile)];
  for (const name of names) {
    if (!/^[a-z0-9.-]+$/.test(name)) throw new Error('Unsafe verification log filename');
    if (existsSync(join(output, name))) copyFileSync(join(output, name), join(archive, name));
  }
}
const git = (...args) => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args[0]} failed`);
  return result.stdout.trim();
};
const sha = value => createHash('sha256').update(value).digest('hex');
const dirty = git('diff', '--name-only', 'HEAD').split('\n').filter(Boolean);
const gitStatus = git('status', '--short');
const snapshotDir = mkdtempSync(join(tmpdir(), 'myrmecia-runtime-v2-baseline-'));
const files = [];
for (const path of dirty) {
  if (/(^|\/)(\.env[^/]*|cookies?[^/]*|session-token|data)(\/|$)/i.test(path)) {
    throw new Error(`Refusing to snapshot sensitive path: ${path}`);
  }
  const source = join(root, path);
  const present = existsSync(source);
  if (present) {
    const target = join(snapshotDir, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
  files.push({ path, present, sha256: present ? sha(readFileSync(source)) : null });
}
const record = {
  schemaVersion: 1, mode, root, startedAt: new Date().toISOString(),
  head: git('rev-parse', 'HEAD'), branch: git('branch', '--show-current'),
  gitStatus, diffSha256: sha(git('diff', '--binary', 'HEAD')), snapshotDir, files,
  verification: [], skipped: ['live Provider/MCP', 'Docker isolation', 'remote CI', 'push/merge'],
};
const persist = () => writeFileSync(join(output, `${mode}.json`), `${JSON.stringify(record, null, 2)}\n`);
persist();
const commands = [
  ['pnpm', ['--filter', '@myrmecia/shared', 'build']],
  ['pnpm', ['--filter', '@myrmecia/server', 'test']],
  ['pnpm', ['--filter', '@myrmecia/dashboard', 'test']],
  ['pnpm', ['--filter', '@myrmecia/server', 'build']],
  ['pnpm', ['--filter', '@myrmecia/dashboard', 'build']],
  ['pnpm', ['--filter', '@myrmecia/desktop', 'exec', 'tsc', '--noEmit']],
  ['pnpm', ['validate:contracts']],
  ['pnpm', ['validate:pipelines']],
  ['pnpm', ['validate:social-workflow']],
  ['git', ['diff', '--check']],
];
for (const [program, args] of commands) {
  const command = [program, ...args].join(' ');
  const startedAt = new Date().toISOString();
  console.log(`START ${command}`);
  const result = spawnSync(program, args, {
    cwd: root, encoding: 'utf8', timeout: 600_000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, AGENT_FACTORY_DEMO_MODE: 'false' },
  });
  const logfile = `${mode}-${String(record.verification.length + 1).padStart(2, '0')}.log`;
  writeFileSync(join(output, logfile), `${result.stdout || ''}\n${result.stderr || ''}`);
  record.verification.push({
    command, cwd: root, startedAt, finishedAt: new Date().toISOString(),
    exitCode: result.status, signal: result.signal, error: result.error?.message, logfile,
  });
  persist();
  console.log(`END ${result.status} ${command}`);
  if (result.status !== 0) {
    console.error((result.stdout || '').slice(-4000), (result.stderr || '').slice(-2000));
    process.exitCode = 1;
    break;
  }
}
record.finishedAt = new Date().toISOString();
record.status = record.verification.length === commands.length && record.verification.every(item => item.exitCode === 0)
  ? 'passed' : 'failed';
persist();
const summary = [
  `# Agent Runtime V2 ${mode}`, '', `Recorded: ${record.finishedAt}`,
  `Repository: ${root}`, `HEAD: ${record.head}`, `Branch: ${record.branch}`,
  `Pre-existing diff SHA-256: ${record.diffSha256}`, `Recovery snapshot: ${snapshotDir}`,
  `Result: ${record.status}`, '',
  '| Command | Exit | Log |', '| --- | --- | --- |',
  ...record.verification.map(item => `| \`${item.command}\` | ${item.exitCode ?? 'terminated'} | ${item.logfile} |`),
  '', 'Live integrations, browser/E2E, remote CI and delivery are separate checks, not proven by this report.',
  'Test-specific skipped cases and warnings remain in the logs; passing process exit does not mean zero skipped tests.',
  '', '## Preserved dirty paths', ...files.map(item => `- ${item.path}: ${item.sha256 || 'deleted before this task'}`), '',
];
writeFileSync(join(output, `${mode}.md`), summary.join('\n'));
console.log(`REPORT artifacts/agent-runtime-v2/${mode}.md: ${record.status}`);
