import { readdirSync, lstatSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Worker } from 'worker_threads';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import { canonicalRoot, excludedWorkspacePath, safeWorkspacePath, readWorkspaceBytes } from '../workspace/path-policy.js';
import type { ToolResult } from './tool-sandbox.js';

const skip = new Set(['coverage', 'target', '.venv', 'venv', '.cache', '.workagent']);
const MAX_FILES = 2000, MAX_BYTES = 32 * 1024 * 1024, MAX_FILE_BYTES = 1024 * 1024;
// Only fixed source runs in the worker. Untrusted regex operates on already
// authorized bytes, never on host paths, and cannot block the server event loop.
const REGEX_WORKER = `
const { parentPort, workerData: data } = require('node:worker_threads');
const regex = new RegExp(data.pattern, data.ignoreCase ? 'i' : '');
const lines = []; let size = 0, incomplete = false;
outer: for (const file of data.files) {
  const content = file.text.split(/\\r?\\n/);
  for (let index = 0; index < content.length; index++) {
    if (!regex.test(content[index])) continue;
    const value = file.path + ':' + (index + 1) + ':' + content[index];
    if (lines.length >= data.maxMatches || size + value.length + 1 > data.maxOutputChars) { incomplete = true; break outer; }
    lines.push(value); size += value.length + 1;
  }
}
parentPort.postMessage({ lines, incomplete });
`;

async function regexSearch(data: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<{ lines: string[]; incomplete: boolean }> {
  if (signal?.aborted) throw new Error('Request aborted');
  const worker = new Worker(REGEX_WORKER, { eval: true, workerData: data, resourceLimits: { maxOldGenerationSizeMb: 128 } });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, value?: { lines: string[]; incomplete: boolean }) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); void worker.terminate();
      if (error) reject(error); else resolve(value!);
    };
    const abort = () => finish(new Error('Request aborted'));
    const timer = setTimeout(() => finish(new Error('Regex search exceeded its bounded time limit')), Math.max(1, timeoutMs));
    signal?.addEventListener('abort', abort, { once: true });
    worker.once('message', (value: { lines: string[]; incomplete: boolean }) => finish(undefined, value));
    worker.once('error', () => finish(new Error('Regex is invalid or exceeds its memory limit')));
    worker.once('exit', () => { if (!settled) finish(new Error('Regex worker stopped before returning a result')); });
    if (signal?.aborted) abort();
  });
}

function globMatcher(glob: string): (path: string) => boolean {
  if (glob.length > 150 || /[\0\r\n\\]/.test(glob) || glob.split('/').includes('..') || glob.startsWith('/')) {
    throw new Error('Search glob must be a bounded workspace-relative pattern');
  }
  const source = glob.split('**/').map(part => part.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')).join('(?:.*/)?');
  const expression = new RegExp(`^${source}$`);
  return path => expression.test(glob.includes('/') ? path : path.split('/').at(-1)!);
}

/** Bounded, language-neutral inventory. Symlinks and secret paths are never read. */
export async function searchWorkspace(
  root: string, input: Record<string, unknown>,
  options: { signal?: AbortSignal; timeoutMs: number; maxOutputChars: number },
): Promise<ToolResult> {
  const pattern = String(input.pattern ?? input.query ?? '');
  if (!pattern.trim() || pattern.length > 500 || /[\0\r\n]/.test(pattern)) throw new Error('Search requires a non-empty single-line pattern, at most 500 characters');
  const canonical = canonicalRoot(root);
  const start = safeWorkspacePath(canonical, String(input.path ?? '.'));
  const matchesGlob = globMatcher(String(input.glob || '*'));
  const requestedMatches = Number(input.maxMatches ?? 100);
  if (!Number.isInteger(requestedMatches) || requestedMatches < 1 || requestedMatches > 500) throw new Error('maxMatches must be between 1 and 500');
  const deadline = Date.now() + Math.min(options.timeoutMs, 10_000);
  const queue: Array<{ path: string; depth: number }> = [{ path: start, depth: 0 }];
  const files: Array<{ path: string; text: string }> = [];
  let visited = 0, bytes = 0, incomplete = false;
  while (queue.length) {
    if (options.signal?.aborted) throw new Error('Request aborted');
    if (Date.now() >= deadline || visited >= MAX_FILES || bytes >= MAX_BYTES) { incomplete = true; break; }
    const item = queue.shift()!;
    visited++;
    if (visited % 50 === 0) await yieldLoop();
    const path = relative(canonical, item.path);
    if (excludedWorkspacePath(path) || path.split('/').some(part => skip.has(part))) continue;
    const info = lstatSync(item.path);
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      if (item.depth >= 8) { incomplete = true; continue; }
      for (const name of readdirSync(item.path).sort()) {
        if (queue.length >= MAX_FILES * 2) { incomplete = true; break; }
        queue.push({ path: join(item.path, name), depth: item.depth + 1 });
      }
      continue;
    }
    if (!info.isFile() || !matchesGlob(path)) continue;
    if (info.size > MAX_FILE_BYTES || bytes + info.size > MAX_BYTES) { incomplete = true; continue; }
    const body = readWorkspaceBytes(canonical, item.path, MAX_FILE_BYTES);
    bytes += body.length;
    if (!body.includes(0)) files.push({ path, text: body.toString('utf8') });
  }
  const lines: string[] = [];
  let outputSize = 0;
  if (input.regex === true && files.length) {
    const result = await regexSearch({ files, pattern, ignoreCase: input.ignoreCase === true,
      maxMatches: requestedMatches, maxOutputChars: Math.max(0, options.maxOutputChars - 220) }, deadline - Date.now(), options.signal);
    lines.push(...result.lines); incomplete ||= result.incomplete;
  } else {
    const needle = input.ignoreCase === true ? pattern.toLowerCase() : pattern;
    outer: for (const file of files) {
      const contentLines = file.text.split(/\r?\n/);
      for (let index = 0; index < contentLines.length; index++) {
        const line = contentLines[index];
        if (!(input.ignoreCase === true ? line.toLowerCase() : line).includes(needle)) continue;
        const found = `${file.path}:${index + 1}:${line}`;
        if (lines.length >= requestedMatches || outputSize + found.length + 1 > Math.max(0, options.maxOutputChars - 220)) {
          incomplete = true; break outer;
        }
        lines.push(found); outputSize += found.length + 1;
      }
    }
  }
  let output = lines.join('\n');
  if (output.length > Math.max(0, options.maxOutputChars - 220)) { output = output.slice(0, Math.max(0, options.maxOutputChars - 220)); incomplete = true; }
  if (!output) output = incomplete ? 'No matches in the scanned portion.' : 'No matches';
  if (incomplete) output += '\n[Search incomplete: file/depth/size/time/match/output limits reached. Narrow path/glob; absence is not proof of no matches.]';
  return { status: 'done', output };
}
