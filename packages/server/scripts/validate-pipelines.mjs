import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

const root = resolve(import.meta.dirname, '../../..');
const templatesRoot = join(root, 'templates');
const registryPath = join(root, 'agents', 'registry.yaml');
const failures = [];

function fail(message) {
  failures.push(message);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function readYaml(relativePath) {
  const absolutePath = join(root, relativePath);
  try {
    return parseYaml(readFileSync(absolutePath, 'utf8'));
  } catch (error) {
    fail(`${relativePath}: invalid YAML (${error.message})`);
    return undefined;
  }
}

function checkDependencies(file, stages) {
  const edges = new Map(stages.map((_, index) => [index, []]));

  stages.forEach((stage, index) => {
    if (stage.depends_on === undefined) return;
    if (!Array.isArray(stage.depends_on)) {
      fail(`${file} stages.${index}.depends_on: must be an array`);
      return;
    }

    for (const dependency of stage.depends_on) {
      if (!Number.isInteger(dependency) || dependency < 0 || dependency >= stages.length) {
        fail(`${file} stages.${index}.depends_on: invalid dependency ${String(dependency)}`);
        continue;
      }
      if (dependency === index) {
        fail(`${file} stages.${index}.depends_on: stage cannot depend on itself`);
      }
      if (dependency >= index) {
        fail(`${file} stages.${index}.depends_on: dependency ${dependency} must refer to an earlier stage`);
      }
      edges.get(dependency).push(index);
    }
  });

  const visiting = new Set();
  const visited = new Set();
  const walk = (node, path) => {
    if (visiting.has(node)) {
      fail(`${file}: dependency cycle detected (${[...path, node].join(' -> ')})`);
      return;
    }
    if (visited.has(node)) return;
    visiting.add(node);
    for (const next of edges.get(node) || []) walk(next, [...path, node]);
    visiting.delete(node);
    visited.add(node);
  };
  for (const index of edges.keys()) walk(index, []);
}

function checkSchemaReference(file, stageIndex, field, value) {
  if (!isNonEmptyString(value)) return;
  const schemaPath = resolve(root, value);
  if (!existsSync(schemaPath)) {
    fail(`${file} stages.${stageIndex}.${field}: referenced file does not exist (${value})`);
    return;
  }
  if (value.endsWith('.json')) {
    try {
      JSON.parse(readFileSync(schemaPath, 'utf8'));
    } catch (error) {
      fail(`${file} stages.${stageIndex}.${field}: invalid JSON (${value}; ${error.message})`);
    }
  }
}

const registry = readYaml('agents/registry.yaml');
const knownRoles = new Set();
for (const agent of registry?.agents || []) {
  if (isNonEmptyString(agent?.id)) knownRoles.add(agent.id);
  if (isNonEmptyString(agent?.role)) knownRoles.add(agent.role);
}

const files = readdirSync(templatesRoot).filter(name => /\.ya?ml$/i.test(name)).sort();
const templateNames = new Set();
let stageCount = 0;

for (const filename of files) {
  const file = `templates/${filename}`;
  const template = readYaml(file);
  if (!template || typeof template !== 'object') continue;

  // gallery.yaml is a catalog of examples, not an executable pipeline.
  if (Array.isArray(template.items) && template.stages === undefined) continue;

  if (!isNonEmptyString(template.name)) {
    fail(`${file}: name is required`);
  } else if (templateNames.has(template.name)) {
    fail(`${file}: duplicate template name "${template.name}"`);
  } else {
    templateNames.add(template.name);
  }

  if (!Array.isArray(template.stages) || template.stages.length === 0) {
    fail(`${file}: stages must be a non-empty array`);
    continue;
  }

  const stageNames = new Set();
  checkDependencies(file, template.stages);
  stageCount += template.stages.length;

  template.stages.forEach((stage, index) => {
    const prefix = `${file} stages.${index}`;
    if (!isNonEmptyString(stage?.name)) {
      fail(`${prefix}.name: required`);
    } else if (stageNames.has(stage.name)) {
      fail(`${prefix}.name: duplicate stage name "${stage.name}"`);
    } else {
      stageNames.add(stage.name);
    }

    if (!isNonEmptyString(stage?.role)) {
      fail(`${prefix}.role: required`);
    } else if (!knownRoles.has(stage.role)) {
      fail(`${prefix}.role: unknown agent role or id "${stage.role}"`);
    }

    if (!isNonEmptyString(stage?.prompt_template) || !stage.prompt_template.includes('{input}')) {
      fail(`${prefix}.prompt_template: must be a non-empty string containing {input}`);
    }

    if (stage.output_schema !== undefined) {
      checkSchemaReference(file, index, 'output_schema', stage.output_schema);
    }

    for (const [inputIndex, input] of (Array.isArray(stage.inputs) ? stage.inputs : []).entries()) {
      checkSchemaReference(file, index, `inputs.${inputIndex}.schemaRef`, input?.schemaRef);
    }
    for (const [outputIndex, output] of (Array.isArray(stage.outputs) ? stage.outputs : []).entries()) {
      checkSchemaReference(file, index, `outputs.${outputIndex}.schemaRef`, output?.schemaRef);
    }

    if (stage.output_policy) {
      if (!isNonEmptyString(stage.output_policy.field)) {
        fail(`${prefix}.output_policy.field: required`);
      }
      if (!Array.isArray(stage.output_policy.allowed_values) || stage.output_policy.allowed_values.length === 0) {
        fail(`${prefix}.output_policy.allowed_values: must be a non-empty array`);
      }
    }

    const publishTools = stage.publish_tools;
    if (publishTools !== undefined) {
      if (!Array.isArray(publishTools) || publishTools.length === 0 || publishTools.some(tool => !isNonEmptyString(tool))) {
        fail(`${prefix}.publish_tools: must be a non-empty array of tool names`);
      }
      if (stage.approval_kind !== 'publish') {
        fail(`${prefix}: a stage with publish_tools must declare approval_kind: publish`);
      }
      if (stage.role !== 'social-publisher') {
        fail(`${prefix}: publish_tools may only be granted to the social-publisher role`);
      }
    }

    if (stage.approval_kind === 'publish' && (!Array.isArray(publishTools) || publishTools.length === 0)) {
      fail(`${prefix}: approval_kind: publish requires publish_tools`);
    }
  });
}

console.log(`Pipeline templates: ${files.length}`);
console.log(`Pipeline stages: ${stageCount}`);
console.log(`Known agent roles: ${knownRoles.size}`);

if (failures.length > 0) {
  console.error(`Pipeline validation failed (${failures.length} errors):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log('Pipeline validation passed');
}
