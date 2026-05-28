// Global test setup
// Mock fetch globally
globalThis.fetch = async () =>
  ({
    ok: true,
    json: async () => ([]),
    text: async () => '',
    headers: new Headers(),
    status: 200,
    statusText: 'OK',
  }) as unknown as Response;

// Mock localStorage
const store: Record<string, string> = {};
globalThis.localStorage = {
  getItem: (key: string) => store[key] ?? null,
  setItem: (key: string, value: string) => { store[key] = value; },
  removeItem: (key: string) => { delete store[key]; },
  clear: () => { Object.keys(store).forEach(k => delete store[k]); },
  get length() { return Object.keys(store).length; },
  key: (index: number) => Object.keys(store)[index] ?? null,
};
