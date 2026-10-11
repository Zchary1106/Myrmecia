import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../src/db/database.js';
import { DlpStreamGuard } from '../src/security/dlp-runtime.js';
beforeEach(() => { process.env.DB_PATH = ':memory:'; });
afterEach(() => { closeDb(); delete process.env.DB_PATH; });
describe('DLP across transport chunk boundaries', () => {
  it('does not emit a secret split across several model deltas', () => {
    const stream = new DlpStreamGuard({ purpose: 'fixture stream' });
    const output: string[] = [];
    output.push(stream.push('A safe introduction. '.repeat(15) + 'sk-'));
    output.push(stream.push('abcdefghij'));
    expect(() => stream.push('klmnopqrstuvwxyz')).toThrow('DLP blocked');
    expect(output.join('')).not.toContain('sk-');
  });
  it('redacts a card split across spaces/chunks and retains incremental Markdown', () => {
    const stream = new DlpStreamGuard({ purpose: 'fixture stream' });
    const intro = '## Result\n\nA safe paragraph for streaming. '.repeat(8);
    const visible = [stream.push(intro + '4111 '), stream.push('1111 1111 '), stream.push('1111\n\nDone.')];
    const final = stream.finish(intro + '4111 1111 1111 1111\n\nDone.');
    visible.push(final.delta);
    expect(visible[0]).not.toBe('');
    expect(visible.join('')).toBe(final.text);
    expect(final.text).toContain('[REDACTED:credit_card]');
    expect(visible.join('')).not.toContain('4111');
  });
  it('does not flush an unfinished tail when cancelled, and refuses inconsistent final output', () => {
    const stream = new DlpStreamGuard({});
    expect(stream.push('Pending unconfirmed output')).toBe('');
    const other = new DlpStreamGuard({});
    other.push('Safe text. '.repeat(40));
    expect(() => other.finish('A contradictory final answer')).toThrow('PREFIX_CHANGED');
  });
});
