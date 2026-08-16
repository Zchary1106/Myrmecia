import { z } from 'zod';
import type {
  AgentContract,
  ArtifactContract,
  ContractValidationIssue,
  ContractValidationResult,
  ExecutionPlanSnapshot,
  GateContractV2,
  ResolvedRoleCapability,
  TeamContractV2,
  WorkflowGraphContract,
  WorkflowNodeV2,
} from '../types.js';

const artifactKindSchema = z.enum([
  'text',
  'markdown',
  'json',
  'code',
  'image',
  'video',
  'audio',
  'document',
  'report',
  'archive',
  'other',
]);

export const artifactRequirementSchema = z.object({
  name: z.string().trim().min(1),
  kind: artifactKindSchema,
  description: z.string().trim().min(1).optional(),
  schemaRef: z.string().trim().min(1).optional(),
  mimeTypes: z.array(z.string().trim().min(1)).optional(),
  required: z.boolean().optional(),
  multiple: z.boolean().optional(),
});

export const artifactDeclarationSchema = artifactRequirementSchema.extend({
  required: z.boolean(),
});

export const agentContractSchema = z.object({
  schemaVersion: z.literal('1.0'),
  agentId: z.string().trim().min(1),
  role: z.string().trim().min(1),
  responsibility: z.object({
    summary: z.string().trim().min(1),
    owns: z.array(z.string().trim().min(1)).min(1),
    doesNotOwn: z.array(z.string().trim().min(1)),
    escalatesTo: z.array(z.string().trim().min(1)).optional(),
  }),
  inputs: z.array(artifactRequirementSchema),
  outputs: z.array(artifactDeclarationSchema).min(1),
  skills: z.array(z.string().trim().min(1)),
  tools: z.array(z.string().trim().min(1)),
  quality: z.object({
    definitionOfDone: z.array(z.string().trim().min(1)).min(1),
    rubric: z.array(z.object({
      id: z.string().trim().min(1),
      description: z.string().trim().min(1),
      weight: z.number().positive().optional(),
      blocking: z.boolean().optional(),
    })).optional(),
  }),
  execution: z.object({
    maxRetries: z.number().int().min(0).max(10).optional(),
    requiresHumanApproval: z.boolean().optional(),
  }).optional(),
});

export const artifactContractSchema = z.object({
  schemaVersion: z.literal('1.0'),
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  kind: artifactKindSchema,
  description: z.string().optional(),
  schemaRef: z.string().trim().min(1).optional(),
  mimeType: z.string().trim().min(1).optional(),
  uri: z.string().trim().min(1).optional(),
  inlineContent: z.string().optional(),
  producer: z.object({
    agentId: z.string().trim().min(1).optional(),
    workflowId: z.string().trim().min(1).optional(),
    nodeId: z.string().trim().min(1).optional(),
    runId: z.string().trim().min(1).optional(),
  }),
  lineage: z.object({
    sourceArtifactIds: z.array(z.string().trim().min(1)),
  }).optional(),
  integrity: z.object({
    algorithm: z.literal('sha256'),
    checksum: z.string().regex(/^[a-f0-9]{64}$/i),
    sizeBytes: z.number().int().nonnegative().optional(),
  }).optional(),
  metadata: z.record(z.unknown()).optional(),
  createdAt: z.string().datetime(),
}).superRefine((artifact, ctx) => {
  if (!artifact.uri && artifact.inlineContent === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['uri'],
      message: 'Artifact must provide uri or inlineContent',
    });
  }
  if (!artifact.producer.agentId && !artifact.producer.nodeId && !artifact.producer.workflowId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['producer'],
      message: 'Artifact producer must identify an agent, workflow, or node',
    });
  }
});

const workflowNodeSchema = z.object({
  id: z.string().trim().min(1),
  label: z.string().optional(),
  kind: z.enum(['agent', 'gate', 'human-approval', 'publisher']).optional(),
  agentId: z.string().trim().min(1).optional(),
  agentRole: z.string().trim().min(1).optional(),
  prompt: z.string().optional(),
  inputArtifacts: z.array(artifactRequirementSchema).optional(),
  outputArtifacts: z.array(artifactDeclarationSchema).optional(),
  requiredSkills: z.array(z.string().trim().min(1)).optional(),
  qualityGate: z.object({
    outputSchema: z.string().trim().min(1).optional(),
    approvalRequired: z.boolean().optional(),
  }).optional(),
  retryPolicy: z.object({
    maxAttempts: z.number().int().min(1).max(10),
    backoffMs: z.number().int().nonnegative().optional(),
    onExhausted: z.enum(['fail', 'human']).optional(),
  }).optional(),
  position: z.object({
    x: z.number(),
    y: z.number(),
  }).optional(),
});

const workflowEdgeSchema = z.object({
  id: z.string().trim().min(1),
  source: z.string().trim().min(1),
  target: z.string().trim().min(1),
  kind: z.enum(['data', 'control', 'approval']).optional(),
  artifactMappings: z.array(z.object({
    from: z.string().trim().min(1),
    to: z.string().trim().min(1),
  })).optional(),
});

export const workflowGraphContractSchema = z.object({
  schemaVersion: z.literal('1.0').optional(),
  nodes: z.array(workflowNodeSchema),
  edges: z.array(workflowEdgeSchema),
});

function zodIssues(error: z.ZodError): ContractValidationIssue[] {
  return error.issues.map(issue => ({
    path: issue.path.length ? issue.path.join('.') : '/',
    message: issue.message,
    code: issue.code,
  }));
}

function duplicateValues(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

function cycleNodes(nodeIds: string[], edges: Array<{ source: string; target: string }>): string[] {
  const indegree = new Map(nodeIds.map(id => [id, 0]));
  const outgoing = new Map(nodeIds.map(id => [id, [] as string[]]));
  for (const edge of edges) {
    if (!indegree.has(edge.source) || !indegree.has(edge.target)) continue;
    indegree.set(edge.target, (indegree.get(edge.target) || 0) + 1);
    outgoing.get(edge.source)!.push(edge.target);
  }
  const queue = nodeIds.filter(id => indegree.get(id) === 0);
  let visited = 0;
  while (queue.length) {
    const current = queue.shift()!;
    visited += 1;
    for (const target of outgoing.get(current) || []) {
      const next = (indegree.get(target) || 0) - 1;
      indegree.set(target, next);
      if (next === 0) queue.push(target);
    }
  }
  return visited === nodeIds.length
    ? []
    : nodeIds.filter(id => (indegree.get(id) || 0) > 0);
}

export function validateAgentContract(value: unknown): ContractValidationResult<AgentContract> {
  const parsed = agentContractSchema.safeParse(value);
  return parsed.success
    ? { valid: true, value: parsed.data as AgentContract, errors: [], warnings: [] }
    : { valid: false, errors: zodIssues(parsed.error), warnings: [] };
}

export function validateArtifactContract(value: unknown): ContractValidationResult<ArtifactContract> {
  const parsed = artifactContractSchema.safeParse(value);
  return parsed.success
    ? { valid: true, value: parsed.data as ArtifactContract, errors: [], warnings: [] }
    : { valid: false, errors: zodIssues(parsed.error), warnings: [] };
}

export function normalizeAgentContract(definition: {
  id: string;
  role: string;
  name?: string;
  description?: string;
  skill?: string;
  skillPath?: string;
  capabilities?: string[];
  allowedTools?: string[];
  allowed_tools?: string[];
  contract?: unknown;
}): { contract: AgentContract; inferred: boolean } {
  if (definition.contract !== undefined) {
    const validated = validateAgentContract(definition.contract);
    if (!validated.valid || !validated.value) {
      const details = validated.errors.map(issue => `${issue.path}: ${issue.message}`).join('; ');
      throw new Error(`Invalid Agent Contract for "${definition.id}": ${details}`);
    }
    if (validated.value.agentId !== definition.id) {
      throw new Error(`Invalid Agent Contract for "${definition.id}": agentId must match registry id`);
    }
    if (validated.value.role !== definition.role) {
      throw new Error(`Invalid Agent Contract for "${definition.id}": role must match registry role`);
    }
    return { contract: validated.value, inferred: false };
  }

  const capabilities = definition.capabilities || [];
  const skill = definition.skill || definition.skillPath;
  const tools = definition.allowedTools || definition.allowed_tools || [];
  return {
    inferred: true,
    contract: {
      schemaVersion: '1.0',
      agentId: definition.id,
      role: definition.role,
      responsibility: {
        summary: definition.description || `${definition.name || definition.id} handles ${definition.role} work.`,
        owns: capabilities.length ? capabilities : [definition.role],
        doesNotOwn: ['Final human approval', 'Undeclared external side effects'],
        escalatesTo: definition.id === 'master' ? [] : ['master'],
      },
      inputs: [{ name: 'task', kind: 'text', required: true }],
      outputs: [{ name: 'result', kind: 'text', required: true }],
      skills: skill ? [skill] : [],
      tools,
      quality: {
        definitionOfDone: [
          'Declared output artifact is produced',
          'Output stays within the assigned responsibility boundary',
        ],
      },
    },
  };
}

export function validateWorkflowGraphContract(
  value: unknown,
  options: { allowEmpty?: boolean } = {},
): ContractValidationResult<WorkflowGraphContract> {
  const parsed = workflowGraphContractSchema.safeParse(value);
  if (!parsed.success) {
    return { valid: false, errors: zodIssues(parsed.error), warnings: [] };
  }

  const graph = parsed.data as WorkflowGraphContract;
  const errors: ContractValidationIssue[] = [];
  const warnings: ContractValidationIssue[] = [];
  if (!options.allowEmpty && graph.nodes.length === 0) {
    errors.push({ path: 'nodes', message: 'Workflow must include at least one node', code: 'empty_graph' });
  }

  for (const id of duplicateValues(graph.nodes.map(node => node.id))) {
    errors.push({ path: 'nodes', message: `Duplicate node id "${id}"`, code: 'duplicate_node' });
  }
  for (const id of duplicateValues(graph.edges.map(edge => edge.id))) {
    errors.push({ path: 'edges', message: `Duplicate edge id "${id}"`, code: 'duplicate_edge' });
  }

  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  graph.nodes.forEach((node, index) => {
    if ((node.kind ?? 'agent') === 'agent' && !node.agentId && !node.agentRole) {
      warnings.push({
        path: `nodes.${index}`,
        message: `Agent node "${node.id}" has no agentId or agentRole; runtime fallback will be used`,
        code: 'implicit_agent',
      });
    }
  });

  graph.edges.forEach((edge, index) => {
    const source = nodes.get(edge.source);
    const target = nodes.get(edge.target);
    if (!source) {
      errors.push({ path: `edges.${index}.source`, message: `Unknown source node "${edge.source}"`, code: 'unknown_node' });
    }
    if (!target) {
      errors.push({ path: `edges.${index}.target`, message: `Unknown target node "${edge.target}"`, code: 'unknown_node' });
    }
    if (edge.source === edge.target) {
      errors.push({ path: `edges.${index}`, message: `Self edge on node "${edge.source}" is not allowed`, code: 'self_edge' });
    }
    for (const [mappingIndex, mapping] of (edge.artifactMappings || []).entries()) {
      if (source?.outputArtifacts?.length && !source.outputArtifacts.some(output => output.name === mapping.from)) {
        errors.push({
          path: `edges.${index}.artifactMappings.${mappingIndex}.from`,
          message: `Source node "${edge.source}" does not declare output "${mapping.from}"`,
          code: 'unknown_output',
        });
      }
      if (target?.inputArtifacts?.length && !target.inputArtifacts.some(input => input.name === mapping.to)) {
        errors.push({
          path: `edges.${index}.artifactMappings.${mappingIndex}.to`,
          message: `Target node "${edge.target}" does not declare input "${mapping.to}"`,
          code: 'unknown_input',
        });
      }
    }
  });

  const cyclic = cycleNodes(graph.nodes.map(node => node.id), graph.edges);
  if (cyclic.length) {
    errors.push({
      path: 'edges',
      message: `Workflow graph contains a cycle involving: ${cyclic.join(', ')}`,
      code: 'cycle',
    });
  }

  return { valid: errors.length === 0, value: graph, errors, warnings };
}

export function validateIndexedWorkflowDependencies(
  stages: Array<{ dependsOn?: number[] }>,
): ContractValidationResult<Array<{ dependsOn?: number[] }>> {
  const errors: ContractValidationIssue[] = [];
  const edges: Array<{ source: string; target: string }> = [];
  stages.forEach((stage, index) => {
    for (const dependency of stage.dependsOn || []) {
      if (!Number.isInteger(dependency) || dependency < 0 || dependency >= stages.length) {
        errors.push({
          path: `stages.${index}.dependsOn`,
          message: `Dependency index ${dependency} is outside the workflow`,
          code: 'invalid_dependency',
        });
        continue;
      }
      if (dependency === index) {
        errors.push({
          path: `stages.${index}.dependsOn`,
          message: 'A stage cannot depend on itself',
          code: 'self_dependency',
        });
      }
      edges.push({ source: String(dependency), target: String(index) });
    }
  });
  const cyclic = cycleNodes(stages.map((_, index) => String(index)), edges);
  if (cyclic.length) {
    errors.push({
      path: 'stages',
      message: `Stage dependencies contain a cycle involving: ${cyclic.join(', ')}`,
      code: 'cycle',
    });
  }
  return { valid: errors.length === 0, value: stages, errors, warnings: [] };
}

// ---------- Contract v2 (Agent / Skill / Domain / Team refactor) ----------

export const teamRoleSlotV2Schema = z.object({
  slot: z.string().trim().min(1),
  agentId: z.string().trim().min(1),
  skills: z.array(z.string().trim().min(1)).optional(),
  tools: z.array(z.string().trim().min(1)).optional(),
  domainIds: z.array(z.string().trim().min(1)).optional(),
});

export const teamPolicyV2Schema = z.object({
  requireHumanApprovalBefore: z.array(z.string().trim().min(1)).optional(),
  allowedTools: z.array(z.string().trim().min(1)).optional(),
  disallowedTools: z.array(z.string().trim().min(1)).optional(),
  maxCostUsd: z.number().nonnegative().optional(),
});

export const teamContractV2Schema = z.object({
  schemaVersion: z.literal('2.0'),
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  version: z.literal(2),
  lead: z.string().trim().min(1),
  domainIds: z.array(z.string().trim().min(1)).optional(),
  roles: z.array(teamRoleSlotV2Schema).min(1, 'Team must declare at least one role slot'),
  policy: teamPolicyV2Schema.optional(),
  pipelineTemplate: z.string().trim().min(1).optional(),
  members: z.array(z.string().trim().min(1)).optional(),
}).superRefine((team, ctx) => {
  const duplicates = duplicateValues(team.roles.map(role => role.slot));
  if (duplicates.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['roles'],
      message: `Duplicate role slots: ${duplicates.join(', ')}`,
    });
  }
  if (!team.roles.some(role => role.slot === team.lead)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['lead'],
      message: `Team lead "${team.lead}" must match a declared role slot`,
    });
  }
});

export const gateContractV2Schema = z.object({
  kind: z.enum(['auto', 'human-approval']),
  reason: z.string().trim().min(1).optional(),
  blocking: z.boolean().optional(),
  requiresApprovalFor: z.array(z.string().trim().min(1)).optional(),
});

export const retryPolicyV2Schema = z.object({
  maxAttempts: z.number().int().min(1).max(10),
  backoffMs: z.number().int().nonnegative().optional(),
  onExhausted: z.enum(['fail', 'human']).optional(),
});

export const fallbackPolicyV2Schema = z.object({
  onFailure: z.enum(['skip', 'human', 'fallback-agent']).optional(),
  fallbackAgentId: z.string().trim().min(1).optional(),
});

export const workflowNodeV2Schema = z.object({
  id: z.string().trim().min(1),
  roleSlot: z.string().trim().min(1),
  requiredCapabilities: z.array(z.string().trim().min(1)),
  skillIds: z.array(z.string().trim().min(1)),
  toolIds: z.array(z.string().trim().min(1)).optional(),
  domainIds: z.array(z.string().trim().min(1)).optional(),
  inputs: z.array(artifactRequirementSchema),
  outputs: z.array(artifactDeclarationSchema).min(1, 'A pipeline node must declare outputs'),
  gate: gateContractV2Schema.optional(),
  retry: retryPolicyV2Schema.optional(),
  fallback: fallbackPolicyV2Schema.optional(),
}).superRefine((node, ctx) => {
  const duplicates = duplicateValues(node.outputs.map(output => output.name));
  if (duplicates.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['outputs'],
      message: `Duplicate output artifact names: ${duplicates.join(', ')}`,
    });
  }
});

export const resolvedRoleCapabilityV2Schema = z.object({
  slot: z.string().trim().min(1),
  agentId: z.string().trim().min(1),
  legacyAgentId: z.string().trim().min(1).optional(),
  skills: z.array(z.string().trim().min(1)),
  tools: z.array(z.string().trim().min(1)),
  domainIds: z.array(z.string().trim().min(1)),
  domains: z.array(z.object({
    id: z.string().trim().min(1),
    version: z.number().int().positive(),
  })).optional(),
  capabilities: z.array(z.string().trim().min(1)),
});

export const executionPlanSnapshotSchema = z.object({
  schemaVersion: z.literal('2.0'),
  snapshotId: z.string().trim().min(1),
  teamId: z.string().trim().min(1),
  teamVersion: z.number().int().positive(),
  pipelineTemplate: z.string().trim().min(1).optional(),
  pipelineVersion: z.string().trim().min(1).optional(),
  roles: z.array(resolvedRoleCapabilityV2Schema).min(1),
  policy: teamPolicyV2Schema,
  gates: z.array(z.object({
    nodeId: z.string().trim().min(1),
    gate: gateContractV2Schema,
  })),
  modelPolicy: z.record(z.unknown()).optional(),
  contextBudget: z.record(z.unknown()).optional(),
  createdAt: z.string().datetime(),
  checksum: z.string().regex(/^[a-f0-9]{64}$/i, 'checksum must be a sha256 hex digest'),
});

function v2Result<T>(valid: true, value: T, errors: ContractValidationIssue[], warnings?: ContractValidationIssue[]): ContractValidationResult<T>;
function v2Result<T>(valid: false, value: undefined, errors: ContractValidationIssue[], warnings?: ContractValidationIssue[]): ContractValidationResult<T>;
function v2Result<T>(
  valid: boolean,
  value: T | undefined,
  errors: ContractValidationIssue[],
  warnings: ContractValidationIssue[] = [],
): ContractValidationResult<T> {
  return { valid, value, errors, warnings };
}

export function validateTeamContractV2(value: unknown): ContractValidationResult<TeamContractV2> {
  const parsed = teamContractV2Schema.safeParse(value);
  return parsed.success
    ? v2Result(true, parsed.data as TeamContractV2, [])
    : v2Result(false, undefined, zodIssues(parsed.error));
}

export function validateWorkflowNodeV2(value: unknown): ContractValidationResult<WorkflowNodeV2> {
  const parsed = workflowNodeV2Schema.safeParse(value);
  return parsed.success
    ? v2Result(true, parsed.data as WorkflowNodeV2, [])
    : v2Result(false, undefined, zodIssues(parsed.error));
}

export function validateResolvedRoleCapability(value: unknown): ContractValidationResult<ResolvedRoleCapability> {
  const parsed = resolvedRoleCapabilityV2Schema.safeParse(value);
  return parsed.success
    ? v2Result(true, parsed.data as ResolvedRoleCapability, [])
    : v2Result(false, undefined, zodIssues(parsed.error));
}

export function validateExecutionPlanSnapshot(value: unknown): ContractValidationResult<ExecutionPlanSnapshot> {
  const parsed = executionPlanSnapshotSchema.safeParse(value);
  return parsed.success
    ? v2Result(true, parsed.data as ExecutionPlanSnapshot, [])
    : v2Result(false, undefined, zodIssues(parsed.error));
}
