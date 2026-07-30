import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = ['preload.cjs', 'dashboard-preload.cjs'];

for (const file of files) {
  const source = resolve(desktopRoot, 'src', file);
  const destination = resolve(desktopRoot, 'dist', file);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}
