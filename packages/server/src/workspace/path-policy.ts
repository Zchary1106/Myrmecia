import { constants, closeSync, existsSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, statSync, writeSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';

export const WORKSPACE_LIMITS = { files: 250, depth: 8, fileBytes: 20 * 1024 * 1024, totalBytes: 100 * 1024 * 1024 };
const EXCLUDED = new Set(['.git', 'node_modules', '.agent-factory', 'dist', 'build', '.next', '.ssh', '.aws', '.gnupg', '.npmrc', '.netrc', 'cookies.json']);
export function excludedWorkspacePath(path: string): boolean {
  return path.split(/[\\/]/).some(part => EXCLUDED.has(part) || /^\.env/i.test(part)
    || /^(credentials|secrets)(\.|$)/i.test(part) || /^(id_rsa|id_ed25519)/.test(part) || /\.(pem|key|p12|pfx|db|sqlite|sqlite3)(-wal|-shm)?$/i.test(part));
}
export function rootIdentity(root: string): string {
  const info = statSync(root);
  if (!info.isDirectory()) throw new Error('WORKSPACE_NOT_DIRECTORY');
  return `${info.dev}:${info.ino}`;
}
export function canonicalRoot(root: string): string {
  const canonical = realpathSync(resolve(root));
  if (canonical === sep || canonical === process.env.HOME) throw new Error('UNSAFE_WORKSPACE_ROOT');
  rootIdentity(canonical);
  return canonical;
}
/** Git must belong to this selected root, never a parent server repository. */
export function ownGitRoot(root: string): boolean {
  const canonical = canonicalRoot(root);
  if (!existsSync(resolve(canonical, '.git'))) return false;
  const top = execFileSync('git', ['-C', canonical, 'rev-parse', '--show-toplevel'], { stdio: 'pipe', encoding: 'utf8' }).trim();
  if (canonicalRoot(top) !== canonical) throw new Error('GIT_WORKSPACE_ROOT_MISMATCH');
  return true;
}
/** Discovery guard only; a host command can deliberately access another root. */
export function workspaceCommandEnvironment(root: string, environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...environment, GIT_CEILING_DIRECTORIES: [dirname(canonicalRoot(root)), environment.GIT_CEILING_DIRECTORIES].filter(Boolean).join(delimiter) };
}
/** Reject even internal symlinks: aliases of a root canonicalize once; children never do. */
export function safeWorkspacePath(root: string, input: string, expectedIdentity?: string): string {
  const canonical = canonicalRoot(root);
  if (expectedIdentity && rootIdentity(canonical) !== expectedIdentity) throw new Error('WORKSPACE_ROOT_CHANGED');
  const candidate = resolve(canonical, input);
  const rel = relative(canonical, candidate);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || input.includes('\0')) throw new Error('WORKSPACE_PATH_ESCAPE: path traversal outside workspace');
  let current = candidate;
  while (current !== canonical) {
    if (existsSync(current)) {
      if (lstatSync(current).isSymbolicLink()) throw new Error('WORKSPACE_SYMLINK_DENIED');
      const actual = realpathSync(current);
      const actualRel = relative(canonical, actual);
      if (actualRel === '..' || actualRel.startsWith(`..${sep}`) || isAbsolute(actualRel)) throw new Error('WORKSPACE_PATH_ESCAPE');
    } else {
      // lstat also catches dangling symlinks, for which existsSync returns false.
      try { if (lstatSync(current).isSymbolicLink()) throw new Error('WORKSPACE_SYMLINK_DENIED'); }
      catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    }
    current = dirname(current);
  }
  return candidate;
}
export function readWorkspaceBytes(root: string, path: string, maxBytes = WORKSPACE_LIMITS.fileBytes): Buffer {
  const identity = rootIdentity(canonicalRoot(root));
  const target = safeWorkspacePath(root, path, identity);
  const fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > maxBytes) throw new Error('WORKSPACE_FILE_QUOTA');
    const buffer = Buffer.allocUnsafe(before.size + 1);
    let used = 0;
    while (used < buffer.length) {
      const read = readSync(fd, buffer, used, buffer.length - used, used);
      if (!read) break; used += read;
    }
    const bytes = buffer.subarray(0, used);
    const after = fstatSync(fd);
    safeWorkspacePath(root, path, identity);
    const named = lstatSync(target);
    if (before.ino !== named.ino || before.dev !== named.dev || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes.length !== after.size) throw new Error('WORKSPACE_FILE_UNSTABLE');
    return bytes;
  } finally { closeSync(fd); }
}
/** FD-first writes mitigate leaf swaps; host policy is still not an OS sandbox. */
export function writeWorkspaceBytes(root: string, path: string, bytes: Buffer): void {
  if (bytes.length > WORKSPACE_LIMITS.fileBytes) throw new Error('WORKSPACE_FILE_QUOTA');
  const identity = rootIdentity(canonicalRoot(root));
  const target = safeWorkspacePath(root, path, identity);
  mkdirSync(dirname(target), { recursive: true });
  safeWorkspacePath(root, path, identity);
  const fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW || 0), 0o600);
  try {
    const opened = fstatSync(fd);
    safeWorkspacePath(root, path, identity);
    const named = lstatSync(target);
    if (!opened.isFile() || opened.ino !== named.ino || opened.dev !== named.dev) throw new Error('WORKSPACE_FILE_UNSTABLE');
    ftruncateSync(fd, 0);
    let written = 0;
    while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written);
    safeWorkspacePath(root, path, identity);
    if (lstatSync(target).ino !== opened.ino) throw new Error('WORKSPACE_FILE_UNSTABLE');
  } finally { closeSync(fd); }
}
