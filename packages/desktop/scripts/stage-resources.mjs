import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(desktopRoot, '..', '..');
const stageRoot = resolve(desktopRoot, '.stage');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

function run(args) {
  execFileSync(pnpm, args, {
    cwd: repositoryRoot,
    stdio: 'inherit',
    // Windows command shims such as pnpm.cmd must be launched through the
    // shell when invoked by Node's synchronous child-process API.
    shell: process.platform === 'win32',
  });
}

// This directory is generated exclusively for packaging. Source package folders
// are never cleaned or modified by this script.
rmSync(stageRoot, { recursive: true, force: true });
mkdirSync(stageRoot, { recursive: true });
run(['--filter', '@myrmecia/shared', 'build']);
run(['--filter', '@myrmecia/server', 'build']);
run(['--filter', '@myrmecia/dashboard', 'build']);
// `pnpm deploy` resolves its destination relative to this process' repository
// cwd. Passing an absolute Windows path through the .cmd shell shim caused it
// to be reinterpreted beneath packages/server; use a repository-relative path.
const deployDestination = relative(repositoryRoot, resolve(stageRoot, 'server'));
const deployArgs = ['--filter', '@myrmecia/server', 'deploy', '--prod', deployDestination];

// pnpm 9 can hit a transient EPERM while creating .bin shims on GitHub's
// Windows runner. The staging directory is entirely generated, so retrying a
// clean deploy is safe; keep non-Windows and persistent failures fail-closed.
function deployServer() {
  const attempts = process.platform === 'win32' ? 3 : 1;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      rmSync(resolve(stageRoot, 'server'), { recursive: true, force: true });
      run(deployArgs);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 1_000);
    }
  }
  throw lastError;
}
deployServer();

const stagedServer = resolve(stageRoot, 'server');
writeFileSync(
  resolve(stagedServer, 'desktop-runtime.json'),
  `${JSON.stringify({
    nodeVersion: process.versions.node,
    nodeModuleVersion: process.versions.modules,
    platform: process.platform,
    arch: process.arch,
  }, null, 2)}\n`,
);
for (const path of ['src', 'tests', 'scripts', 'packages', '.env.example', 'tsconfig.json', 'vitest.config.ts']) {
  rmSync(resolve(stagedServer, path), { recursive: true, force: true });
}
// pnpm deploy leaves a virtual self-link to the source workspace. The server
// never resolves it, and preserving it would make the signed app point outside
// its Resources directory.
try {
  unlinkSync(resolve(stagedServer, 'node_modules/.pnpm/node_modules/@myrmecia/server'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
