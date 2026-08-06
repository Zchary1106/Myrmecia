import { describe, expect, it } from 'vitest';
import { extractStructuredOutput, validateStageOutput } from './stage-output-validator.js';
import type { PipelineStage } from '../types.js';
import { buildPipelineRunSnapshot } from './pipeline-engine.js';

describe('stage output validation', () => {
  it('extracts JSON from a fenced model response', () => {
    expect(extractStructuredOutput('Result:\n```json\n{"ok":true}\n```')).toEqual({ ok: true });
  });

  it('blocks an output that violates its policy', () => {
    const stage: PipelineStage = {
      index: 0,
      name: 'Preflight',
      agentRole: 'social-preflight',
      status: 'running',
      outputPolicy: {
        field: 'ok',
        allowedValues: [true],
        onFailure: 'blocked',
      },
    };

    const result = validateStageOutput(stage, '{"ok":false,"errors":["not logged in"]}');
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('"ok"');
  });

  it('validates a preflight output against its JSON Schema', () => {
    const stage: PipelineStage = {
      index: 0,
      name: 'Preflight',
      agentRole: 'social-preflight',
      status: 'running',
      outputSchema: 'docs/social-workflow/preflight-result.schema.json',
      outputPolicy: { field: 'ok', allowedValues: [true] },
    };
    const output = JSON.stringify({
      schema_version: '1.0',
      content_id: 'social-20260804-test-1',
      checked_at: '2026-08-04T00:00:00.000Z',
      ok: true,
      platforms: [{
        platform: 'xiaohongshu',
        account_login: 'authenticated',
        required_assets: ['/tmp/card.png'],
        draft_or_schedule_conflict: false,
        idempotency_key: 'social-test-xhs',
      }],
      errors: [],
      warnings: [],
    });

    expect(validateStageOutput(stage, output)).toMatchObject({ valid: true, errors: [] });
  });

  it('builds a run snapshot that conforms to the declared schema', () => {
    const snapshot = buildPipelineRunSnapshot({
      id: 'pipe-test',
      name: 'Social workflow',
      status: 'running',
      currentStageIndex: 0,
      gateMode: 'manual',
      input: 'topic',
      createdAt: '2026-08-04T00:00:00.000Z',
      stages: [{
        index: 0,
        name: 'Core',
        agentRole: 'content-strategist',
        status: 'done',
        output: '{"content_id":"social-20260804-test-1","asset":"/tmp/card.png"}',
      }],
    });
    const stage: PipelineStage = {
      index: 0,
      name: 'Snapshot',
      agentRole: 'developer',
      status: 'running',
      outputSchema: 'docs/social-workflow/content-run-snapshot.schema.json',
    };

    expect(validateStageOutput(stage, JSON.stringify(snapshot))).toMatchObject({
      valid: true,
      errors: [],
    });
    expect(snapshot.assets).toEqual([{ path: '/tmp/card.png' }]);
  });
});
