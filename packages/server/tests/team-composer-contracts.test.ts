import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  normalizeAgentContract,
  validateAgentContract,
  validateArtifactContract,
  validateIndexedWorkflowDependencies,
  validateWorkflowGraphContract,
} from '../src/contracts/team-composer-contracts.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('Team Composer contracts', () => {
  it('normalizes every built-in agent and preserves explicit core contracts', () => {
    const registry = parseYaml(readFileSync(resolve(repositoryRoot, 'agents/registry.yaml'), 'utf8')) as {
      agents: any[];
    };
    const normalized = registry.agents.map(agent => ({
      id: agent.id,
      ...normalizeAgentContract(agent),
    }));

    expect(normalized.length).toBeGreaterThan(20);
    expect(normalized.every(item => validateAgentContract(item.contract).valid)).toBe(true);
    expect(normalized.find(item => item.id === 'dev')?.inferred).toBe(false);
    expect(normalized.find(item => item.id === 'social-publisher')?.contract.execution?.requiresHumanApproval).toBe(true);
  });

  it('rejects an explicit contract whose identity does not match the registry', () => {
    expect(() => normalizeAgentContract({
      id: 'dev',
      role: 'developer',
      contract: {
        schemaVersion: '1.0',
        agentId: 'other',
        role: 'developer',
        responsibility: { summary: 'Builds code', owns: ['code'], doesNotOwn: [] },
        inputs: [],
        outputs: [{ name: 'implementation', kind: 'code', required: true }],
        skills: [],
        tools: [],
        quality: { definitionOfDone: ['Code is implemented'] },
      },
    })).toThrow(/agentId must match/);
  });

  it('requires artifact content or a URI and a traceable producer', () => {
    const invalid = validateArtifactContract({
      schemaVersion: '1.0',
      id: 'artifact-1',
      name: 'Test report',
      kind: 'report',
      producer: {},
      createdAt: '2026-08-13T00:00:00.000Z',
    });
    expect(invalid.valid).toBe(false);
    expect(invalid.errors.map(error => error.message)).toEqual(expect.arrayContaining([
      expect.stringContaining('uri or inlineContent'),
      expect.stringContaining('producer'),
    ]));
  });

  it('validates typed artifact mappings in an acyclic workflow', () => {
    const result = validateWorkflowGraphContract({
      schemaVersion: '1.0',
      nodes: [
        {
          id: 'build',
          agentRole: 'developer',
          outputArtifacts: [{ name: 'implementation', kind: 'code', required: true }],
        },
        {
          id: 'qa',
          agentRole: 'tester',
          inputArtifacts: [{ name: 'candidate', kind: 'code', required: true }],
          outputArtifacts: [{ name: 'test-report', kind: 'report', required: true }],
        },
      ],
      edges: [{
        id: 'build-to-qa',
        source: 'build',
        target: 'qa',
        kind: 'data',
        artifactMappings: [{ from: 'implementation', to: 'candidate' }],
      }],
    });

    expect(result).toMatchObject({ valid: true, errors: [] });
  });

  it('rejects cycles, missing nodes, and undeclared artifact mappings', () => {
    const result = validateWorkflowGraphContract({
      nodes: [
        {
          id: 'a',
          agentRole: 'developer',
          outputArtifacts: [{ name: 'code', kind: 'code', required: true }],
        },
        {
          id: 'b',
          agentRole: 'tester',
          inputArtifacts: [{ name: 'candidate', kind: 'code', required: true }],
        },
      ],
      edges: [
        {
          id: 'e1',
          source: 'a',
          target: 'b',
          artifactMappings: [{ from: 'missing', to: 'candidate' }],
        },
        { id: 'e2', source: 'b', target: 'a' },
        { id: 'e3', source: 'missing-node', target: 'b' },
      ],
    });

    expect(result.valid).toBe(false);
    expect(result.errors.map(error => error.code)).toEqual(expect.arrayContaining([
      'cycle',
      'unknown_node',
      'unknown_output',
    ]));
  });

  it('rejects invalid and cyclic indexed stage dependencies', () => {
    expect(validateIndexedWorkflowDependencies([
      { dependsOn: [1] },
      { dependsOn: [0] },
      { dependsOn: [9] },
    ]).errors.map(error => error.code)).toEqual(expect.arrayContaining([
      'cycle',
      'invalid_dependency',
    ]));
  });
});
