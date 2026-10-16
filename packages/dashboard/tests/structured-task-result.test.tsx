import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { StructuredTaskResult, structuredResultSummary } from '../src/components/common/StructuredTaskResult';

describe('truthful structured validation display', () => {
  it('does not show a historical zero-test exit 0 as green completed', () => {
    const output = JSON.stringify({ command: 'npm test', exitCode: 0, stdout: 'ℹ tests 0\nℹ pass 0' });
    const html = renderToStaticMarkup(<StructuredTaskResult output={output} />);
    expect(html).toContain('Validation needs attention');
    expect(html).toContain('没有执行测试用例');
    expect(html).toContain('Exit code 0');
    expect(html).not.toContain('Validation completed');
    expect(structuredResultSummary(output)).toContain('needs attention');
  });
  it('shows completion for real positive test evidence', () => {
    const output = JSON.stringify({ command: 'npm test', exitCode: 0, stdout: 'ℹ tests 12\nℹ pass 12' });
    expect(renderToStaticMarkup(<StructuredTaskResult output={output} />)).toContain('Validation completed');
  });
  it('shows real test evidence as completed when npm prints its package-version banner', () => {
    const output = JSON.stringify({ command: 'npm test', exitCode: 0,
      stdout: '> pilot@1.0.0 test\n> node --test\nℹ tests 9\nℹ pass 9\nℹ skipped 0\n' });
    expect(renderToStaticMarkup(<StructuredTaskResult output={output} />)).toContain('Validation completed');
  });
  it('does not prematurely approve partially streamed JSON or missing coverage', () => {
    for (const output of ['{"command":"npm test","exitCode":0', '{"command":"npm test","exitCode":0}']) {
      expect(renderToStaticMarkup(<StructuredTaskResult output={output} />)).not.toContain('Validation completed');
    }
  });
});
