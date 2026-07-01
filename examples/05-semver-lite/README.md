# Example 05 — semver-lite

A **dependency-free** TypeScript semantic-version parser and comparator,
including SemVer prerelease-precedence rules.

> **Written end-to-end by the Myrmecia dev agent** (direct task). 10/10 tests pass.

## API

```ts
parse('v1.2.3-rc.1')  // { major:1, minor:2, patch:3, prerelease:['rc','1'] }
isValid('1.2.3')      // true
compare('1.2.0', '1.10.0')     // -1
compare('1.0.0-rc.1', '1.0.0') // -1  (prerelease < release)
gt('2.0.0', '1.9.9')           // true
eq('1.0.0', 'v1.0.0')          // true
```

## Test

```bash
cd examples/05-semver-lite
npm install   # only tsx
npm test      # node:test, 10 tests
```

## How it was generated

```bash
pnpm cli run dev "Create a dependency-free TypeScript semver parse/compare/isValid/gt/lt/eq library with prerelease precedence and tests using node:test"
```
