import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(desktopRoot, 'src', 'preload.cjs');
const destination = resolve(desktopRoot, 'dist', 'preload.cjs');

mkdirSync(dirname(destination), { recursive: true });
copyFileSync(source, destination);
