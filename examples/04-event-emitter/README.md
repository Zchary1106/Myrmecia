# Example 04 — typed event emitter

A **dependency-free**, strongly-typed pub/sub emitter for TypeScript.

> **Written end-to-end by the Myrmecia dev agent** (direct task). 8/8 tests pass.

## API

```ts
const bus = createEmitter<{ login: { userId: string }; logout: void }>();
const off = bus.on('login', ({ userId }) => console.log(userId)); // returns unsubscribe
bus.once('logout', () => {});
bus.emit('login', { userId: 'u1' });
off();
bus.removeAllListeners();
```

Guarantees: handlers fire in registration order; `on` returns an unsubscribe;
`once` fires at most once; a throwing handler never blocks later handlers
(errors are collected and rethrown, aggregated when multiple).

## Test

```bash
cd examples/04-event-emitter
npm install   # only tsx
npm test      # node:test, 8 tests
```

## How it was generated

```bash
pnpm cli run dev "Create a dependency-free, strongly-typed event emitter (on/once/off/emit) with tests using node:test"
```
