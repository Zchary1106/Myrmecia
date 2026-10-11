/** Compatibility switch stays opt-in until final staged acceptance. */
export function runtimeV2Enabled(): boolean {
  return process.env.MYRMECIA_RUNTIME_V2 === 'true';
}
