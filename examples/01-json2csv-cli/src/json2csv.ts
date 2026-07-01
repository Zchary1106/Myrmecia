import { readFile } from 'node:fs/promises';
import { stdin, stdout, stderr, argv } from 'node:process';

type JsonRow = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonRow {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function escapeCsvField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }

  return value;
}

function serializeValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }

  if (typeof value === 'object') {
    return JSON.stringify(value);
  }

  return String(value);
}

function collectHeaders(rows: JsonRow[]): string[] {
  const headers: string[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        headers.push(key);
      }
    }
  }

  return headers;
}

function assertValidRows(rows: object[]): JsonRow[] {
  if (!Array.isArray(rows)) {
    throw new TypeError('Input must be an array of objects.');
  }

  return rows.map((row, index) => {
    if (!isPlainObject(row)) {
      throw new TypeError(`Row at index ${index} must be an object.`);
    }

    return row;
  });
}

export function jsonToCsv(rows: object[]): string {
  const validRows = assertValidRows(rows);

  if (validRows.length === 0) {
    return '';
  }

  const headers = collectHeaders(validRows);
  const headerLine = headers.map(escapeCsvField).join(',');
  const dataLines = validRows.map((row) => {
    const fields = headers.map((header) => {
      const serializedValue = serializeValue(row[header]);
      return escapeCsvField(serializedValue);
    });

    return fields.join(',');
  });

  return [headerLine, ...dataLines].join('\n');
}

function parseJsonInput(input: string): JsonRow[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error('Input is not valid JSON.');
  }

  if (!Array.isArray(parsed)) {
    throw new Error('Input JSON must be an array of objects.');
  }

  return parsed.map((item, index) => {
    if (!isPlainObject(item)) {
      throw new Error(`Item at index ${index} must be an object.`);
    }

    return item;
  });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString('utf8');
}

function getHelpText(): string {
  return [
    'Usage: json2csv [file]',
    '',
    'Convert a JSON array of objects to CSV.',
    '',
    'Options:',
    '  --help     Show this help message',
    '',
    'Examples:',
    '  tsx src/json2csv.ts data.json',
    '  cat data.json | tsx src/json2csv.ts',
  ].join('\n');
}

async function runCli(): Promise<void> {
  const args = argv.slice(2);

  if (args.includes('--help')) {
    stdout.write(`${getHelpText()}\n`);
    return;
  }

  if (args.length > 1) {
    throw new Error('Expected at most one file path argument.');
  }

  const input = args[0] ? await readFile(args[0], 'utf8') : await readStdin();
  const rows = parseJsonInput(input);
  const csv = jsonToCsv(rows);

  stdout.write(csv);
  if (csv.length > 0) {
    stdout.write('\n');
  }
}

if (import.meta.url === `file://${argv[1]}`) {
  runCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Unknown error.';
    stderr.write(`Error: ${message}\n`);
    process.exitCode = 1;
  });
}
