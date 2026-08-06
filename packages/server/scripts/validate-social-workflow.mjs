import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const root = resolve(import.meta.dirname, '../../..');
const failures = [];
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

function expect(condition, message) {
  if (!condition) failures.push(message);
}

function readJson(relativePath) {
  try {
    return JSON.parse(readFileSync(resolve(root, relativePath), 'utf8'));
  } catch (error) {
    failures.push(`${relativePath}: invalid JSON (${error.message})`);
    return undefined;
  }
}

function readYaml(relativePath) {
  try {
    return parseYaml(readFileSync(resolve(root, relativePath), 'utf8'));
  } catch (error) {
    failures.push(`${relativePath}: invalid YAML (${error.message})`);
    return undefined;
  }
}

const requiredDocs = [
  'docs/social-workflow/content-package.schema.json',
  'docs/social-workflow/preflight-result.schema.json',
  'docs/social-workflow/publish-result.schema.json',
  'docs/social-workflow/compensation-plan.schema.json',
  'docs/social-workflow/performance-report.schema.json',
  'docs/social-workflow/content-run-snapshot.schema.json',
  'docs/social-workflow/publishing-schedule.schema.json',
  'docs/social-workflow/compliance-rules.yaml',
  'docs/social-workflow/compliance-report.schema.json',
  'docs/social-workflow/review-package.schema.json',
  'docs/social-workflow/media-qa-report.schema.json',
  'docs/social-workflow/image-generation-report.schema.json',
  'docs/social-workflow/asset-naming.md',
];

for (const file of requiredDocs) expect(existsSync(resolve(root, file)), `Missing required social workflow artifact: ${file}`);
for (const file of requiredDocs.filter(file => file.endsWith('.json'))) {
  const schema = readJson(file);
  expect(schema?.$schema === 'https://json-schema.org/draft/2020-12/schema', `${file}: must declare JSON Schema 2020-12`);
  if (schema) {
    try {
      ajv.compile(schema);
    } catch (error) {
      failures.push(`${file}: invalid JSON Schema (${error.message})`);
    }
  }
}

const rulebook = readYaml('docs/social-workflow/compliance-rules.yaml');
const ruleIds = rulebook?.rules?.map(rule => rule.id) ?? [];
expect(ruleIds.length >= 5, 'compliance-rules.yaml: at least five rules are required');
expect(new Set(ruleIds).size === ruleIds.length, 'compliance-rules.yaml: rule IDs must be unique');

const template = readYaml('templates/social-content-three-lanes.yaml');
const stages = template?.stages ?? [];
expect(template?.name === 'Social Content Three Lanes', 'social-content-three-lanes.yaml: unexpected template name');
expect(stages.length >= 14, 'social-content-three-lanes.yaml: expected full production lifecycle stages');
for (const [index, stage] of stages.entries()) {
  expect(typeof stage.name === 'string' && stage.name.length > 0, `stage ${index}: missing name`);
  expect(typeof stage.role === 'string' && stage.role.length > 0, `stage ${index}: missing role`);
  expect(typeof stage.prompt_template === 'string' && stage.prompt_template.includes('{input}'), `stage ${index}: prompt_template must include {input}`);
  if (stage.output_schema) {
    expect(existsSync(resolve(root, stage.output_schema)), `stage ${index}: output_schema does not exist (${stage.output_schema})`);
  }
  if (stage.output_policy) {
    expect(typeof stage.output_policy.field === 'string' && stage.output_policy.field.length > 0, `stage ${index}: output_policy.field is required`);
    expect(Array.isArray(stage.output_policy.allowed_values) && stage.output_policy.allowed_values.length > 0, `stage ${index}: output_policy.allowed_values is required`);
  }
  for (const dependency of stage.depends_on ?? []) {
    expect(Number.isInteger(dependency) && dependency >= 0 && dependency < index, `stage ${index}: invalid dependency ${dependency}`);
  }
}

const publishing = stages.find(stage => stage.name === '发布执行');
expect(Array.isArray(publishing?.publish_tools) && publishing.publish_tools.length >= 3, '发布执行: governed publish_tools are required');

const xiaohongshuTemplate = readYaml('templates/xiaohongshu-publish.yaml');
const xiaohongshuStages = xiaohongshuTemplate?.stages ?? [];
expect(xiaohongshuTemplate?.name === 'Xiaohongshu Publish', 'xiaohongshu-publish.yaml: unexpected template name');
expect(xiaohongshuStages.length === 8, 'xiaohongshu-publish.yaml: expected eight standalone stages');
expect(
  !xiaohongshuStages.some(stage => stage.role === 'douyin-writer'),
  'xiaohongshu-publish.yaml: standalone Xiaohongshu workflow must not contain douyin-writer',
);
for (const [index, stage] of xiaohongshuStages.entries()) {
  expect(typeof stage.prompt_template === 'string' && stage.prompt_template.includes('{input}'), `xiaohongshu stage ${index}: prompt_template must include {input}`);
  for (const dependency of stage.depends_on ?? []) {
    expect(Number.isInteger(dependency) && dependency >= 0 && dependency < index, `xiaohongshu stage ${index}: invalid dependency ${dependency}`);
  }
  if (stage.output_schema) {
    expect(existsSync(resolve(root, stage.output_schema)), `xiaohongshu stage ${index}: output_schema does not exist (${stage.output_schema})`);
  }
}

const registry = readYaml('agents/registry.yaml');
const agentIds = new Set((registry?.agents ?? []).map(agent => agent.id));
for (const id of ['trend-scout', 'content-strategist', 'douyin-writer', 'xiaohongshu-writer', 'wechat-writer', 'social-compliance-reviewer', 'social-review-coordinator', 'media-qa', 'social-preflight', 'social-publisher', 'social-ops', 'social-analytics']) {
  expect(agentIds.has(id), `agents/registry.yaml: missing ${id}`);
}
expect(agentIds.has('xiaohongshu-visual-designer'), 'agents/registry.yaml: missing xiaohongshu-visual-designer');
expect(
  existsSync(resolve(root, 'skills/xiaohongshu-visual-creator/SKILL.md')),
  'Missing Xiaohongshu visual creator skill',
);

if (failures.length > 0) {
  console.error('Social workflow validation failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Social workflow validation passed (${stages.length} stages, ${ruleIds.length} compliance rules).`);
}
