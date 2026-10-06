import type { ToolFailure, ToolFailureCode } from '@myrmecia/shared';

export function classifyToolFailure(message: string, readOnly = false): ToolFailure {
  let code: ToolFailureCode = 'TOOL_FAILED';
  if (/cancelled|aborted/i.test(message)) code = 'CANCELLED';
  else if (/LOGIN_REQUIRED|not logged in|login required/i.test(message)) code = 'LOGIN_REQUIRED';
  else if (/QUEUE_TIMEOUT|queue.*timeout/i.test(message)) code = 'QUEUE_TIMEOUT';
  else if (/timeout|timed out|READ_TIMEOUT/i.test(message)) code = 'EXECUTION_TIMEOUT';
  else if (/not connected|unavailable|connection refused|ECONNREFUSED/i.test(message)) code = 'NOT_CONNECTED';
  else if (/not allowed|permission|forbidden|approval|required confirmation/i.test(message)) code = 'PERMISSION_DENIED';
  else if (/invalid (?:input|argument|parameter)|validation/i.test(message)) code = 'INVALID_INPUT';
  return {
    code, message,
    retryable: readOnly && ['QUEUE_TIMEOUT', 'EXECUTION_TIMEOUT', 'NOT_CONNECTED'].includes(code),
    outcomeUnknown: !readOnly && ['EXECUTION_TIMEOUT', 'NOT_CONNECTED', 'TOOL_FAILED'].includes(code),
  };
}
