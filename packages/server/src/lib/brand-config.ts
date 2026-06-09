/**
 * Brand-aware runtime config.
 *
 * The platform is migrating its brand to "Myrmecia". New env vars use the
 * `MYRMECIA_*` prefix; the legacy `AGENT_FACTORY_*` names remain supported as
 * fallbacks so existing deployments keep working.
 */

export const DEFAULT_MODEL_BASE_URL = 'https://your-model-endpoint.example.com/v1';

/** Read an env var preferring the new name, falling back to the legacy one. */
export function envWithAlias(primary: string, legacy: string): string | undefined {
  return process.env[primary] ?? process.env[legacy];
}

export function modelBaseURL(): string {
  return envWithAlias('MYRMECIA_BASE_URL', 'AGENT_FACTORY_BASE_URL') || DEFAULT_MODEL_BASE_URL;
}

export function modelApiKey(): string {
  return envWithAlias('MYRMECIA_API_KEY', 'AGENT_FACTORY_API_KEY') || process.env.ANTHROPIC_API_KEY || '';
}

export function defaultModel(fallback = 'gpt-5.4-mini'): string {
  return envWithAlias('MYRMECIA_MODEL', 'AGENT_FACTORY_MODEL') || fallback;
}
