import type { StreamAccumulation } from './gateway.js';

export type FailedRequestUsage = StreamAccumulation['usage'];
// Only the trusted provider adapter can attach observations. Do not parse numbers from error text.
const observations = new WeakMap<object, FailedRequestUsage>();
export function attachFailedRequestUsage(error: object, usage: FailedRequestUsage): void {
  observations.set(error, { ...usage });
}
export function failedRequestUsage(error: unknown): FailedRequestUsage | undefined {
  return error && typeof error === 'object' ? observations.get(error) : undefined;
}
