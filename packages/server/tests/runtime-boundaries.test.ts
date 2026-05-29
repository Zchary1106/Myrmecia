import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, getAsyncDb, getDb } from '../src/db/database.js';
import { getExecutor, resetExecutorForTests } from '../src/agents/executor.js';

const originalEnv = {
  DATABASE_URL: process.env.DATABASE_URL,
  ALLOW_EXPERIMENTAL_POSTGRES: process.env.ALLOW_EXPERIMENTAL_POSTGRES,
  NODE_ENV: process.env.NODE_ENV,
  EXECUTOR_MODE: process.env.EXECUTOR_MODE,
  ALLOW_LOCAL_EXECUTOR_IN_PRODUCTION: process.env.ALLOW_LOCAL_EXECUTOR_IN_PRODUCTION,
};

afterEach(() => {
  closeDb();
  resetExecutorForTests();
  restoreEnv('DATABASE_URL', originalEnv.DATABASE_URL);
  restoreEnv('ALLOW_EXPERIMENTAL_POSTGRES', originalEnv.ALLOW_EXPERIMENTAL_POSTGRES);
  restoreEnv('NODE_ENV', originalEnv.NODE_ENV);
  restoreEnv('EXECUTOR_MODE', originalEnv.EXECUTOR_MODE);
  restoreEnv('ALLOW_LOCAL_EXECUTOR_IN_PRODUCTION', originalEnv.ALLOW_LOCAL_EXECUTOR_IN_PRODUCTION);
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe('runtime safety boundaries', () => {
  it('fails fast instead of silently using SQLite when DATABASE_URL is configured', () => {
    process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/agent_factory';

    expect(() => getDb()).toThrow(/DATABASE_URL/);
  });

  it('requires an explicit PostgreSQL experimental flag for async DB access', () => {
    process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/agent_factory';
    delete process.env.ALLOW_EXPERIMENTAL_POSTGRES;

    expect(() => getAsyncDb()).toThrow(/PostgreSQL support is experimental/);
  });

  it('blocks the local executor in production unless explicitly overridden', () => {
    process.env.NODE_ENV = 'production';
    process.env.EXECUTOR_MODE = 'local';
    delete process.env.ALLOW_LOCAL_EXECUTOR_IN_PRODUCTION;

    expect(() => getExecutor()).toThrow(/Local executor is not allowed in production/);
  });
});
