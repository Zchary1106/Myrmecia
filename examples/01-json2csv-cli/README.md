# Example 01 — json2csv CLI

A small, **dependency-free** TypeScript CLI that converts a JSON array of objects
into CSV. Reads from a file or stdin, escapes commas/quotes/newlines correctly,
and ships with a full test suite.

> **This code was written end-to-end by the Myrmecia agent harness.** A `Feature`
> pipeline (PM → Dev → QA → Review) produced the spec, the implementation, and
> the tests. All 12 tests pass. It's committed here verbatim as a real showcase
> of what the platform generates.

## Use it

```bash
cd examples/01-json2csv-cli
npm install            # only tsx, to run TypeScript directly

# from stdin
echo '[{"name":"Alice","age":30},{"name":"Bob, Jr.","note":"he said \"hi\""}]' \
  | npx tsx src/json2csv.ts

# from a file
npx tsx src/json2csv.ts data.json

# help
npx tsx src/json2csv.ts --help

# tests (node:test, zero external test deps)
npm test
```

Expected output for the stdin example:

```csv
name,age,note
Alice,30,
"Bob, Jr.",,"he said ""hi"""
```

## How it was generated

With a model endpoint configured (see [`../README.md`](../README.md)):

```bash
pnpm cli pipeline Feature \
  "Build a small, dependency-free TypeScript CLI that converts a JSON array of \
   objects into CSV. Read from a file or stdin, support --help, quote values \
   containing commas/quotes/newlines, export a pure jsonToCsv(rows): string, and \
   write unit tests with Node's built-in node:test (no external deps)."
```

The dev agent used its sandboxed engineering tools (`file_write`, `apply_patch`,
`shell_exec`) to write the files and run the tests inside an isolated workspace
under `.agent-factory/workspaces/`.
