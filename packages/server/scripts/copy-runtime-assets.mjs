import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(serverRoot, 'src/db/schema.sql');
const destination = resolve(serverRoot, 'dist/db/schema.sql');

mkdirSync(dirname(destination), { recursive: true });
copyFileSync(source, destination);
