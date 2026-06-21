import { afterAll, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const originalDbPath = process.env.DB_PATH;
const originalTestDbPath = process.env.AGENT_FACTORY_TEST_DB_PATH;
const testDbDir = mkdtempSync(join(tmpdir(), 'agent-factory-vitest-'));
const testDbPath = join(testDbDir, 'test.db');

process.env.DB_PATH = testDbPath;
process.env.AGENT_FACTORY_TEST_DB_PATH = testDbPath;

function ensureTestDbPath() {
  if (!process.env.DB_PATH && !process.env.DATABASE_URL) {
    process.env.DB_PATH = testDbPath;
  }
}

beforeEach(ensureTestDbPath);
afterEach(ensureTestDbPath);

afterAll(async () => {
  ensureTestDbPath();
  const { closeDb } = await vi.importActual<typeof import('../src/db/database.js')>('../src/db/database.js');
  closeDb();

  if (originalDbPath === undefined) {
    if (process.env.DB_PATH === testDbPath) {
      delete process.env.DB_PATH;
    }
  } else {
    process.env.DB_PATH = originalDbPath;
  }

  if (originalTestDbPath === undefined) {
    delete process.env.AGENT_FACTORY_TEST_DB_PATH;
  } else {
    process.env.AGENT_FACTORY_TEST_DB_PATH = originalTestDbPath;
  }

  rmSync(testDbDir, { recursive: true, force: true });
});
