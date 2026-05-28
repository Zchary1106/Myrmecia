import { describe, it, expect } from 'vitest';
import { validateParamConstraints, type ParamConstraints } from './param-constraints.js';

describe('validateParamConstraints', () => {
  it('returns empty array when no constraints defined', () => {
    const violations = validateParamConstraints({ url: 'https://example.com' }, {});
    expect(violations).toEqual([]);
  });

  it('blocks URL from disallowed domain', () => {
    const constraints: ParamConstraints = {
      url: { allowedDomains: ['example.com', '*.trusted.org'] },
    };
    const violations = validateParamConstraints({ url: 'https://evil.com/data' }, constraints);
    expect(violations.length).toBe(1);
    expect(violations[0].param).toBe('url');
    expect(violations[0].message).toContain('evil.com');
  });

  it('allows URL from exact domain match', () => {
    const constraints: ParamConstraints = {
      url: { allowedDomains: ['example.com'] },
    };
    const violations = validateParamConstraints({ url: 'https://example.com/page' }, constraints);
    expect(violations.length).toBe(0);
  });

  it('allows URL from wildcard domain match', () => {
    const constraints: ParamConstraints = {
      url: { allowedDomains: ['*.github.com'] },
    };
    const violations = validateParamConstraints({ url: 'https://api.github.com/repos' }, constraints);
    expect(violations.length).toBe(0);
  });

  it('blocks value exceeding maxLength', () => {
    const constraints: ParamConstraints = {
      query: { maxLength: 10 },
    };
    const violations = validateParamConstraints({ query: 'this is way too long for the limit' }, constraints);
    expect(violations.length).toBe(1);
    expect(violations[0].message).toContain('maximum length');
  });

  it('allows value within maxLength', () => {
    const constraints: ParamConstraints = {
      query: { maxLength: 100 },
    };
    const violations = validateParamConstraints({ query: 'short query' }, constraints);
    expect(violations.length).toBe(0);
  });

  it('blocks value not matching pattern', () => {
    const constraints: ParamConstraints = {
      url: { pattern: '^https://' },
    };
    const violations = validateParamConstraints({ url: 'http://example.com' }, constraints);
    expect(violations.length).toBe(1);
    expect(violations[0].message).toContain('pattern');
  });

  it('allows value matching pattern', () => {
    const constraints: ParamConstraints = {
      url: { pattern: '^https://' },
    };
    const violations = validateParamConstraints({ url: 'https://example.com' }, constraints);
    expect(violations.length).toBe(0);
  });

  it('blocks blocked value', () => {
    const constraints: ParamConstraints = {
      command: { blockedValues: ['rm -rf /', 'DROP TABLE'] },
    };
    const violations = validateParamConstraints({ command: 'rm -rf /' }, constraints);
    expect(violations.length).toBe(1);
    expect(violations[0].message).toContain('blocked');
  });

  it('reports multiple violations', () => {
    const constraints: ParamConstraints = {
      url: { maxLength: 5 },
      query: { pattern: '^[a-z]+$' },
    };
    const violations = validateParamConstraints({ url: 'https://example.com', query: 'Hello World 123' }, constraints);
    expect(violations.length).toBe(2);
  });

  it('skips constraint check for undefined parameter', () => {
    const constraints: ParamConstraints = {
      url: { maxLength: 10 },
    };
    const violations = validateParamConstraints({}, constraints);
    expect(violations.length).toBe(0);
  });
});
