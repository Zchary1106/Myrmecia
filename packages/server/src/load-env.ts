/**
 * Load environment variables from the repository-root `.env` before anything
 * else runs.
 *
 * The dev entrypoint (`tsx watch src/index.ts`) and `node dist/index.js` do not
 * auto-load `.env`, so without this the server starts with no model API key
 * (`AGENT_FACTORY_API_KEY`), no executor override (`AGENT_EXECUTOR`), etc., and
 * every agent LLM call fails with `401 Missing API key`. Best-effort and silent
 * if the file is absent; real, already-exported env vars still take precedence.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const candidates = [
  join(process.cwd(), '.env'),
  join(process.cwd(), '..', '..', '.env'),
  join(here, '..', '..', '..', '.env'),
];

const loadEnvFile = (process as unknown as { loadEnvFile?: (p: string) => void }).loadEnvFile;

for (const path of candidates) {
  if (existsSync(path)) {
    try {
      loadEnvFile?.(path);
    } catch {
      /* ignore malformed/locked .env */
    }
    break;
  }
}
