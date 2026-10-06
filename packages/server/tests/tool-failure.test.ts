import { describe, expect, it } from 'vitest';
import { classifyToolFailure } from '../src/tools/tool-failure.js';

describe('tool error contract', () => {
  it.each([
    ['XHS_LOGIN_REQUIRED: not logged in', 'LOGIN_REQUIRED'],
    ['XHS_QUEUE_TIMEOUT', 'QUEUE_TIMEOUT'],
    ['Request aborted', 'CANCELLED'],
    ['MCP is not connected', 'NOT_CONNECTED'],
    ['Approval required', 'PERMISSION_DENIED'],
    ['Invalid input', 'INVALID_INPUT'],
  ])('classifies %s', (message, code) => {
    expect(classifyToolFailure(message).code).toBe(code);
  });
  it('allows bounded read retries, but treats write timeouts as indeterminate', () => {
    expect(classifyToolFailure('Timeout', true)).toMatchObject({ retryable: true, outcomeUnknown: false });
    expect(classifyToolFailure('Timeout', false)).toMatchObject({ retryable: false, outcomeUnknown: true });
    expect(classifyToolFailure('Request aborted', true).retryable).toBe(false);
  });
});
