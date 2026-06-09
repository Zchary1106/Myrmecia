/**
 * Brand-config env alias precedence (MYRMECIA_* preferred, AGENT_FACTORY_* fallback).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { envWithAlias, modelBaseURL, modelApiKey, defaultModel, DEFAULT_MODEL_BASE_URL } from '../src/lib/brand-config.js';

const KEYS = ['MYRMECIA_BASE_URL', 'AGENT_FACTORY_BASE_URL', 'MYRMECIA_API_KEY', 'AGENT_FACTORY_API_KEY', 'MYRMECIA_MODEL', 'AGENT_FACTORY_MODEL', 'ANTHROPIC_API_KEY'];
afterEach(() => { for (const k of KEYS) delete process.env[k]; });

describe('brand-config env aliases', () => {
  it('prefers the new name over the legacy one', () => {
    process.env.AGENT_FACTORY_BASE_URL = 'https://legacy/v1';
    process.env.MYRMECIA_BASE_URL = 'https://new/v1';
    expect(envWithAlias('MYRMECIA_BASE_URL', 'AGENT_FACTORY_BASE_URL')).toBe('https://new/v1');
    expect(modelBaseURL()).toBe('https://new/v1');
  });

  it('falls back to the legacy name when the new one is unset', () => {
    process.env.AGENT_FACTORY_MODEL = 'legacy-model';
    expect(defaultModel()).toBe('legacy-model');
  });

  it('uses defaults when nothing is set', () => {
    expect(modelBaseURL()).toBe(DEFAULT_MODEL_BASE_URL);
    expect(defaultModel()).toBe('gpt-5.4-mini');
    expect(modelApiKey()).toBe('');
  });

  it('modelApiKey falls back to ANTHROPIC_API_KEY', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    expect(modelApiKey()).toBe('sk-test');
    process.env.MYRMECIA_API_KEY = 'sk-new';
    expect(modelApiKey()).toBe('sk-new');
  });
});
