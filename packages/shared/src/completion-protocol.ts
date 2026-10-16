export type CompletionCriterion =
  | { id: string; label: string; required: boolean; verifier: 'artifact'; relativePath: string; expectedSha256?: string }
  | { id: string; label: string; required: boolean; verifier: 'output_contains'; text: string }
  | { id: string; label: string; required: boolean; verifier: 'output_not_contains'; text: string }
  | { id: string; label: string; required: boolean; verifier: 'output_json_schema'; schema: Record<string, unknown> }
  | { id: string; label: string; required: boolean; verifier: 'human_review'; rubric: string }
  | { id: string; label: string; required: boolean; verifier: 'test_command'; command: string; timeoutMs?: number }
  | { id: string; label: string; required: boolean; verifier: 'external'; verifierId: string };

export interface CompletionCriterionResult {
  criterionId: string; verifier: CompletionCriterion['verifier']; required: boolean;
  status: 'passed' | 'failed' | 'unavailable'; scope: 'artifact' | 'output' | 'workspace' | 'external';
  message: string; evidence: { ref: string; sha256: string }[];
}
export interface CompletionVerification {
  schemaVersion: 1; status: 'not_requested' | 'passed' | 'failed' | 'unavailable';
  contractSha256: string; checkedAt: string; criteria: CompletionCriterionResult[];
}

/** A narrow display/control protocol; arbitrary model JSON is not trusted as task completion. */
export function parseAgentInputRequest(output: string): string | undefined {
  try {
    const value = JSON.parse(output.trim());
    if (!value || value.kind !== 'myrmecia.request_input' || typeof value.question !== 'string'
      || !value.question.trim() || value.question.length > 8000
      || Object.keys(value).some(key => !['kind', 'question'].includes(key))) return undefined;
    return value.question.trim();
  } catch { return undefined; }
}
