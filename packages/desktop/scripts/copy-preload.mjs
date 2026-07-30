import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  ['src/preload.cjs', 'dist/preload.cjs'],
  ['src/dashboard-preload.cjs', 'dist/dashboard-preload.cjs'],
  ['assets/icon.png', 'dist/icon.png'],
];

for (const [sourcePath, destinationPath] of files) {
  const source = resolve(desktopRoot, sourcePath);
  const destination = resolve(desktopRoot, destinationPath);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}
