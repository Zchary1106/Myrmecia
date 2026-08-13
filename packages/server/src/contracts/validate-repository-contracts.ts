import { existsSync, readFileSync, readdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { parse as parseYaml } from 'yaml';
import {
  artifactDeclarationSchema,
  artifactRequirementSchema,
  normalizeAgentContract,
  validateIndexedWorkflowDependencies,
} from './team-composer-contracts.js';

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = [
  process.env.MYRMECIA_RESOURCE_ROOT,
  resolve(moduleDirectory, '../../../..'),
  process.cwd(),
  resolve(process.cwd(), '../..'),
].filter((candidate): candidate is string => Boolean(candidate))
  .find(candidate => existsSync(join(candidate, 'agents/registry.yaml')) && existsSync(join(candidate, 'templates')));

if (!repositoryRoot) {
  console.error('Unable to locate repository resources');
  process.exitCode = 1;
} else {
  const errors: string[] = [];
  const warnings: string[] = [];
  const registry = parseYaml(readFileSync(join(repositoryRoot, 'agents/registry.yaml'), 'utf8')) as {
    agents?: any[];
  };
  const agents = registry.agents || [];
  const identities = new Set<string>();
  let explicitContracts = 0;

  for (const agent of agents) {
    try {
      const normalized = normalizeAgentContract(agent);
      identities.add(String(agent.id));
      identities.add(String(agent.role));
      if (normalized.inferred) warnings.push(`agent ${agent.id}: contract inferred from legacy fields`);
      else explicitContracts += 1;
    } catch (error) {
      errors.push((error as Error).message);
    }
  }

  let pipelineTemplates = 0;
  for (const file of readdirSync(join(repositoryRoot, 'templates')).filter(name => /\.ya?ml$/i.test(name))) {
    const path = join(repositoryRoot, 'templates', file);
    const parsed = parseYaml(readFileSync(path, 'utf8')) as { name?: string; stages?: any[] } | undefined;
    if (!parsed?.name || !Array.isArray(parsed.stages)) continue;
    pipelineTemplates += 1;

    const dependencyResult = validateIndexedWorkflowDependencies(
      parsed.stages.map(stage => ({ dependsOn: stage.depends_on }))
    );
    for (const issue of dependencyResult.errors) errors.push(`${file} ${issue.path}: ${issue.message}`);

    parsed.stages.forEach((stage, index) => {
      if (!identities.has(String(stage.role))) {
        errors.push(`${file} stages.${index}.role: unknown agent role or id "${stage.role}"`);
      }
      for (const [inputIndex, input] of (stage.inputs || []).entries()) {
        const result = artifactRequirementSchema.safeParse(input);
        if (!result.success) {
          for (const issue of result.error.issues) {
            errors.push(`${file} stages.${index}.inputs.${inputIndex}.${issue.path.join('.')}: ${issue.message}`);
          }
        }
      }
      for (const [outputIndex, output] of (stage.outputs || []).entries()) {
        const result = artifactDeclarationSchema.safeParse(output);
        if (!result.success) {
          for (const issue of result.error.issues) {
            errors.push(`${file} stages.${index}.outputs.${outputIndex}.${issue.path.join('.')}: ${issue.message}`);
          }
        }
      }
    });
  }

  console.log(`Agent contracts: ${agents.length} total, ${explicitContracts} explicit, ${agents.length - explicitContracts} inferred`);
  console.log(`Workflow templates: ${pipelineTemplates} validated`);
  if (warnings.length) {
    console.log(`Warnings: ${warnings.length}`);
    for (const warning of warnings) console.log(`  - ${warning}`);
  }
  if (errors.length) {
    console.error(`Errors: ${errors.length}`);
    for (const error of errors) console.error(`  - ${error}`);
    process.exitCode = 1;
  } else {
    console.log('Contract validation passed');
  }
}

