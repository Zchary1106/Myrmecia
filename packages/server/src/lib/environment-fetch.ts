import {
  ProxyAgent,
  fetch as undiciFetch,
  type Dispatcher,
  type RequestInit,
  type Response,
} from 'undici';
import { getProxyForUrl } from 'proxy-from-env';

const proxyAgents = new Map<string, ProxyAgent>();

export function proxyEnvironmentConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY);
}

function environmentDispatcher(url: string): Dispatcher | undefined {
  const proxy = getProxyForUrl(url);
  if (!proxy) return undefined;
  let agent = proxyAgents.get(proxy);
  if (!agent) {
    agent = new ProxyAgent(proxy);
    proxyAgents.set(proxy, agent);
  }
  return agent;
}

/**
 * Node's built-in fetch does not consistently honor HTTP(S)_PROXY. Keep proxy
 * routing local to outbound web tools so loopback APIs and MCP stay untouched.
 */
export function environmentFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const url = input.toString();
  const dispatcher = environmentDispatcher(url);
  return undiciFetch(url, dispatcher ? { ...init, dispatcher } : init);
}

export function safeNetworkError(error: unknown): string {
  const status = error instanceof Error ? /^Fetch failed: (\d{3})/.exec(error.message)?.[1] : undefined;
  if (status) return `HTTP request failed with status ${status}`;
  const code = (error as any)?.cause?.code || (error as any)?.code;
  if (code === 'ECONNREFUSED' && proxyEnvironmentConfigured()) {
    return 'configured proxy refused the connection';
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'DNS lookup failed';
  if ((error as any)?.name === 'AbortError' || code === 'UND_ERR_ABORTED') return 'request timed out';
  if (code === 'ECONNRESET') return 'connection reset';
  return 'network request failed';
}

export async function closeEnvironmentFetch(): Promise<void> {
  const agents = [...proxyAgents.values()];
  proxyAgents.clear();
  await Promise.all(agents.map(agent => agent.close().catch(() => undefined)));
}
