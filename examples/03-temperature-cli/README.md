# Example 03 — temperature converter CLI

A **dependency-free** TypeScript CLI + library to convert temperatures between
Celsius, Fahrenheit, and Kelvin, with absolute-zero validation.

> **Written end-to-end by the Myrmecia dev agent** (direct task). 10/10 tests pass
> (including 2 CLI integration tests).

## Use it

```bash
cd examples/03-temperature-cli
npm install   # only tsx

npx tsx src/tempconvert.ts 100 C F     # 212
npx tsx src/tempconvert.ts 32 F K      # 273.15
npx tsx src/tempconvert.ts --help
npm test                               # node:test, 10 tests
```

## API

```ts
convert(value: number, from: "C"|"F"|"K", to: "C"|"F"|"K"): number
// rounds to <= 2 decimals; throws RangeError below absolute zero
```

## How it was generated

```bash
pnpm cli run dev "Create a dependency-free TypeScript temperature converter (C/F/K) library + CLI with --help and tests using node:test"
```
