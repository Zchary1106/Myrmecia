import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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
// A hoisted deployment without .bin links avoids pnpm's Windows junction/
// symlink creation path, which can fail on GitHub-hosted Windows runners
// without Developer Mode. The staged server starts its entrypoint directly,
// so CLI shims are not needed inside the Electron Resources tree.
run([
  '--filter', '@myrmecia/server',
  'deploy', '--prod',
  '--config.node-linker=hoisted',
  '--config.bin-links=false',
  resolve(stageRoot, 'server'),
]);

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
