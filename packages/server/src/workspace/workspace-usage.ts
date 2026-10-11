import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
/** Bounded metadata-only inventory; never claim a truncated size is an exact total. */
export function workspaceUsage(root: string): { directoryBytes: number; sizeTruncated: boolean } {
  let directoryBytes = 0, visited = 0, sizeTruncated = false;
  const walk = (path: string, depth: number) => {
    if (depth > 8 || visited >= 1000) { sizeTruncated = true; return; }
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (++visited > 1000) { sizeTruncated = true; break; }
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.isSymbolicLink()) { sizeTruncated = true; continue; }
      if (entry.isDirectory()) walk(join(path, entry.name), depth + 1);
      else if (entry.isFile()) directoryBytes += statSync(join(path, entry.name)).size;
    }
  };
  try { walk(root, 0); } catch { sizeTruncated = true; }
  return { directoryBytes, sizeTruncated };
}
