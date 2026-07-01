# Example 02 — slugify library

A **dependency-free** TypeScript utility that turns arbitrary text into a URL
slug, with options and accent transliteration.

> **Written end-to-end by the Myrmecia dev agent** (direct task). 7/7 tests pass.

## API

```ts
slugify(input: string, options?: {
  separator?: string;   // default "-"
  lower?: boolean;      // default true
  maxLength?: number;   // truncates without a trailing separator
}): string
```

```ts
slugify('Crème Brûlée jalapeño über')            // "creme-brulee-jalapeno-uber"
slugify('Hello World', { lower: false })          // "Hello-World"
slugify('One two three four', { maxLength: 13 })  // "one-two-three"
```

## Test

```bash
cd examples/02-slugify
npm install   # only tsx
npm test      # node:test, 7 tests
```

## How it was generated

```bash
pnpm cli run dev "Create a dependency-free TypeScript slugify(input, options) utility with accent transliteration and tests using node:test"
```
