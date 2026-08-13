import { createHash } from 'crypto';
import { v4 as uuid } from 'uuid';
import type {
  ArtifactContract,
  ArtifactDeclaration,
  WorkflowGraphContract,
  WorkflowIntervention,
  WorkflowNodeContract,
  WorkflowNodeRunStatus,
} from '../types.js';
import { extractStructuredOutput } from '../pipelines/stage-output-validator.js';

export interface WorkflowNodeState {
  status: WorkflowNodeRunStatus;
  taskId?: string;
  agentId?: string;
  output?: string;
  artifactIds?: string[];
  attempt: number;
  maxAttempts: number;
  error?: string;
  validationErrors?: string[];
  intervention?: WorkflowIntervention;
  startedAt?: string;
  completedAt?: string;
}

export interface WorkflowRunState {
  runId: string;
  input: string;
  nodes: Record<string, WorkflowNodeState>;
  artifacts: Record<string, ArtifactContract>;
  startedAt: string;
  updatedAt: string;
}

const TRANSITIONS: Record<WorkflowNodeRunStatus, WorkflowNodeRunStatus[]> = {
  pending: ['ready', 'skipped', 'cancelled'],
  ready: ['running', 'waiting_approval', 'done', 'failed', 'cancelled'],
  running: ['done', 'retrying', 'waiting_approval', 'blocked', 'failed', 'cancelled'],
  retrying: ['ready', 'running', 'waiting_approval', 'failed', 'cancelled'],
  waiting_approval: ['done', 'failed', 'retrying', 'cancelled'],
  blocked: ['done', 'failed', 'retrying', 'cancelled'],
  done: [],
  failed: ['retrying'],
  skipped: ['pending', 'retrying'],
  cancelled: [],
};

export function transitionWorkflowNode(
  state: WorkflowNodeState,
  next: WorkflowNodeRunStatus,
  patch: Partial<WorkflowNodeState> = {},
): WorkflowNodeState {
  if (state.status !== next && !TRANSITIONS[state.status].includes(next)) {
    throw new Error(`Invalid workflow node transition: ${state.status} -> ${next}`);
  }
  return { ...state, ...patch, status: next };
}

export function initialWorkflowNodeState(node: WorkflowNodeContract): WorkflowNodeState {
  return {
    status: 'pending',
    attempt: 0,
    maxAttempts: node.retryPolicy?.maxAttempts || 1,
  };
}

function stringifyArtifactValue(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

function projectedContent(
  output: string,
  declaration: ArtifactDeclaration,
  declarationCount: number,
): { content: string; projection: 'named-field' | 'full-output' } {
  if (declarationCount > 1) {
    try {
      const structured = extractStructuredOutput(output);
      if (structured && typeof structured === 'object' && declaration.name in structured) {
        return {
          content: stringifyArtifactValue((structured as Record<string, unknown>)[declaration.name]),
          projection: 'named-field',
        };
      }
    } catch {
      // Multi-output plain text remains available as a full-output projection.
    }
  }
  return { content: output, projection: 'full-output' };
}

export function createNodeArtifacts(data: {
  workflowId: string;
  runId: string;
  node: WorkflowNodeContract;
  agentId?: string;
  output: string;
  sourceArtifactIds?: string[];
}): ArtifactContract[] {
  const declarations: ArtifactDeclaration[] = data.node.outputArtifacts?.length
    ? data.node.outputArtifacts
    : [{ name: 'result', kind: 'markdown', required: true }];
  return declarations.map(declaration => {
    const { content, projection } = projectedContent(data.output, declaration, declarations.length);
    return {
      schemaVersion: '1.0',
      id: `wfa_${uuid().slice(0, 12)}`,
      name: declaration.name,
      kind: declaration.kind,
      description: declaration.description,
      schemaRef: declaration.schemaRef,
      mimeType: declaration.mimeTypes?.[0],
      inlineContent: content,
      producer: {
        agentId: data.agentId,
        workflowId: data.workflowId,
        nodeId: data.node.id,
        runId: data.runId,
      },
      lineage: { sourceArtifactIds: data.sourceArtifactIds || [] },
      integrity: {
        algorithm: 'sha256',
        checksum: createHash('sha256').update(content).digest('hex'),
        sizeBytes: Buffer.byteLength(content),
      },
      metadata: { projection },
      createdAt: new Date().toISOString(),
    };
  });
}

export interface WorkflowInputArtifact {
  artifact: ArtifactContract;
  inputName: string;
  sourceNodeId: string;
}

export function collectNodeInputArtifacts(
  graph: WorkflowGraphContract,
  runState: WorkflowRunState,
  nodeId: string,
): WorkflowInputArtifact[] {
  const collected: WorkflowInputArtifact[] = [];
  for (const edge of graph.edges.filter(candidate => candidate.target === nodeId)) {
    const sourceState = runState.nodes[edge.source];
    const sourceArtifacts = (sourceState?.artifactIds || [])
      .map(id => runState.artifacts[id])
      .filter((artifact): artifact is ArtifactContract => Boolean(artifact));
    if (edge.artifactMappings?.length) {
      for (const mapping of edge.artifactMappings) {
        const artifact = sourceArtifacts.find(candidate => candidate.name === mapping.from);
        if (artifact) collected.push({ artifact, inputName: mapping.to, sourceNodeId: edge.source });
      }
    } else {
      collected.push(...sourceArtifacts.map(artifact => ({
        artifact,
        inputName: artifact.name,
        sourceNodeId: edge.source,
      })));
    }
  }
  return collected;
}

export function validateRequiredNodeInputs(
  node: WorkflowNodeContract,
  inputs: WorkflowInputArtifact[],
): string[] {
  const names = new Set(inputs.map(input => input.inputName));
  return (node.inputArtifacts || [])
    .filter(requirement => requirement.required !== false && !names.has(requirement.name))
    .map(requirement => `Missing required input artifact "${requirement.name}"`);
}

export function assembleArtifactDrivenInput(
  node: WorkflowNodeContract,
  inputs: WorkflowInputArtifact[],
  globalInput: string,
): string {
  const parts: string[] = [];
  if (globalInput) parts.push(`# Goal\n${globalInput}`);
  if (node.prompt) parts.push(node.prompt.replace('{input}', globalInput));
  else if (node.label) parts.push(`## Your role\n${node.label}`);
  if ((node.kind || 'agent') === 'gate') {
    parts.push(
      '## Independent quality gate\n'
      + 'Evaluate only the declared artifacts below. Do not assume hidden conversation context or trust upstream conclusions.'
    );
  }
  if (inputs.length) {
    parts.push('## Input artifacts\n' + inputs.map(input => {
      const schema = input.artifact.schemaRef ? `\nSchema: ${input.artifact.schemaRef}` : '';
      return `### ${input.inputName}\nSource node: ${input.sourceNodeId}${schema}\n${input.artifact.inlineContent || ''}`;
    }).join('\n\n'));
  }
  parts.push('Return only the declared output artifact content and include verifiable evidence for quality decisions.');
  return parts.join('\n\n');
}
