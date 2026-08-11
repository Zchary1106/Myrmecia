import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { PipelineStage } from '../types.js';

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

export interface StageOutputValidation {
  valid: boolean;
  value?: unknown;
  errors: string[];
}

export function lintDeterministicOutput(output: string): string[] {
  const errors: string[] = [];
  const codeBlocks = [...output.matchAll(/```(?:bash|sh|shell|zsh|console|text)?\s*\n([\s\S]*?)```/gi)]
    .map(match => match[1] || '');
  for (const block of codeBlocks) {
    const badCommand = block.split('\n').find(line =>
      /\b(?:git|gh|pnpm|npm|yarn|node|python|pip|curl|wget|docker)\b.*[—–−]\w/.test(line)
    );
    if (badCommand) {
      errors.push(`Command contains a Unicode dash instead of ASCII "--": ${badCommand.trim().slice(0, 160)}`);
      break;
    }
  }
  if (/https?：\/\//i.test(output)) {
    errors.push('URL contains a full-width colon; use https:// with ASCII punctuation');
  }
  if (output.includes('\u0000')) errors.push('Output contains a NUL character');
  return errors;
}

export function extractStructuredOutput(output: string): unknown {
  const trimmed = output.trim();
  if (!trimmed) throw new Error('Stage output is empty');

  const candidates = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  const firstObject = trimmed.indexOf('{');
  const lastObject = trimmed.lastIndexOf('}');
  if (firstObject >= 0 && lastObject > firstObject) {
    candidates.push(trimmed.slice(firstObject, lastObject + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next representation.
    }
  }
  throw new Error('Stage output does not contain valid JSON');
}

function resolveRuntimeAsset(relativePath: string): string | undefined {
  const candidates = [
    process.env.MYRMECIA_RESOURCE_ROOT && join(process.env.MYRMECIA_RESOURCE_ROOT, relativePath),
    resolve(moduleDirectory, '../../../..', relativePath),
    resolve(process.cwd(), relativePath),
    resolve(process.cwd(), '..', relativePath),
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find(existsSync);
}

function valueAtPath(value: unknown, field: string): unknown {
  return field.split('.').reduce<unknown>((current, key) => {
    if (!current || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[key];
  }, value);
}

export function validateStageOutput(stage: PipelineStage, output: string): StageOutputValidation {
  const deterministicErrors = lintDeterministicOutput(output);
  if (!stage.outputSchema && !stage.outputPolicy) {
    return { valid: deterministicErrors.length === 0, errors: deterministicErrors };
  }

  let value: unknown;
  try {
    value = extractStructuredOutput(output);
  } catch (error) {
    return { valid: false, errors: [(error as Error).message] };
  }

  const errors: string[] = [...deterministicErrors];
  if (stage.outputSchema) {
    const schemaPath = resolveRuntimeAsset(stage.outputSchema);
    if (!schemaPath) {
      errors.push(`Output schema not found: ${stage.outputSchema}`);
    } else {
      try {
        const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
        const validate = ajv.compile(schema);
        if (!validate(value)) {
          errors.push(...(validate.errors || []).map(error =>
            `${error.instancePath || '/'} ${error.message || 'is invalid'}`
          ));
        }
      } catch (error) {
        errors.push(`Unable to validate output schema: ${(error as Error).message}`);
      }
    }
  }

  if (stage.outputPolicy) {
    const actual = valueAtPath(value, stage.outputPolicy.field);
    const allowed = stage.outputPolicy.allowedValues.some(expected => Object.is(expected, actual));
    if (!allowed) {
      errors.push(
        stage.outputPolicy.message
        || `Output field "${stage.outputPolicy.field}" must be one of ${JSON.stringify(stage.outputPolicy.allowedValues)}; received ${JSON.stringify(actual)}`
      );
    }
  }

  return { valid: errors.length === 0, value, errors };
}
