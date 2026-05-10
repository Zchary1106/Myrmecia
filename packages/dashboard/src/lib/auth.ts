const STORAGE_KEY = 'agentFactory.apiToken';

export function getApiAuthToken(): string {
  const envToken = ((import.meta as ImportMeta & { env?: Record<string, string> }).env?.VITE_API_AUTH_TOKEN) || '';
  try {
    return window.localStorage.getItem(STORAGE_KEY) || envToken;
  } catch {
    return envToken;
  }
}

export function setApiAuthToken(token: string) {
  window.localStorage.setItem(STORAGE_KEY, token);
}

export function clearApiAuthToken() {
  window.localStorage.removeItem(STORAGE_KEY);
}
