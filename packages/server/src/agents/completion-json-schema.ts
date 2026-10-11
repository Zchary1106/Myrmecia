import Ajv2020 from 'ajv/dist/2020.js';

// Deliberately bounded structural subset. No regex, references, remote schemas,
// recursive/combinatorial schemas, formats, defaults or coercion.
const keywords = new Set(['type', 'properties', 'required', 'additionalProperties', 'items',
  'minItems', 'maxItems', 'minLength', 'maxLength', 'minimum', 'maximum', 'enum', 'const', 'description', 'title']);
const types = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const ajv = new Ajv2020({ strict: true, allErrors: false, validateFormats: false });
export const MAX_EVALUATION_OUTPUT_BYTES = 200_000;

export function boundedJsonSchema(schema: Record<string, unknown>): boolean {
  try {
    if (Buffer.byteLength(JSON.stringify(schema)) > 16_000) return false;
    let nodes = 0;
    function visit(value: unknown, depth: number): void {
      if (++nodes > 100 || depth > 10 || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('SCHEMA_BOUND');
      const node = value as Record<string, unknown>;
      if (Object.keys(node).some(key => !keywords.has(key)) || !types.has(String(node.type))) throw new Error('SCHEMA_KEYWORD');
      if (node.properties !== undefined) {
        if (!node.properties || typeof node.properties !== 'object' || Array.isArray(node.properties)
          || Object.keys(node.properties).length > 50) throw new Error('SCHEMA_PROPERTIES');
        for (const child of Object.values(node.properties)) visit(child, depth + 1);
      }
      if (node.items !== undefined) visit(node.items, depth + 1);
      if (node.additionalProperties !== undefined && typeof node.additionalProperties !== 'boolean') throw new Error('SCHEMA_ADDITIONAL');
      if (node.required !== undefined && (!Array.isArray(node.required) || node.required.length > 50
        || node.required.some(key => typeof key !== 'string' || key.length > 200))) throw new Error('SCHEMA_REQUIRED');
      if (node.enum !== undefined && (!Array.isArray(node.enum) || node.enum.length > 50)) throw new Error('SCHEMA_ENUM');
      const scalar = (item: unknown) => item === null || typeof item === 'string'
        || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item));
      if (node.enum !== undefined && (node.enum as unknown[]).some(item => !scalar(item))) throw new Error('SCHEMA_ENUM');
      if (node.const !== undefined && !scalar(node.const)) throw new Error('SCHEMA_CONST');
      for (const key of ['minItems', 'maxItems', 'minLength', 'maxLength']) {
        if (node[key] !== undefined && (!Number.isInteger(node[key]) || Number(node[key]) < 0 || Number(node[key]) > 10_000)) throw new Error('SCHEMA_BOUND');
      }
    }
    visit(schema, 0);
    // New Ajv per schema: never retain arbitrary user schemas in a global cache.
    new Ajv2020({ strict: true, allErrors: false, validateFormats: false }).compile(schema);
    return true;
  } catch { return false; }
}

export function outputMatchesSchema(output: string, schema: Record<string, unknown>): boolean {
  if (Buffer.byteLength(output) > MAX_EVALUATION_OUTPUT_BYTES || !boundedJsonSchema(schema)) return false;
  try {
    const value: unknown = JSON.parse(output);
    let nodes = 0;
    const visit = (item: unknown, depth: number): void => {
      if (++nodes > 10_000 || depth > 30) throw new Error('OUTPUT_BOUND');
      if (item && typeof item === 'object') for (const child of Object.values(item)) visit(child, depth + 1);
    };
    visit(value, 0);
    const validate = ajv.compile(schema);
    try { return !!validate(value); } finally { ajv.removeSchema(schema); }
  } catch { return false; }
}
