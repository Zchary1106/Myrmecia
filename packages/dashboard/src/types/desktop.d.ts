interface MyrmeciaWeChatConfiguration {
  available: true;
  configured: boolean;
  appId: string;
  secureStorageAvailable: boolean;
  recoveryMessage?: string;
}

interface MyrmeciaDesktopIntegrations {
  getRuntimeConfig(): Promise<MyrmeciaRuntimeConfiguration>;
  saveRuntimeConfig(input: { provider: 'openai-compatible' | 'deepseek' | 'copilot'; baseUrl?: string; model?: string; apiKey?: string }): Promise<MyrmeciaRuntimeConfiguration>;
  getWeChatConfig(): Promise<MyrmeciaWeChatConfiguration>;
  saveWeChatConfig(input: { appId: string; appSecret: string }): Promise<MyrmeciaWeChatConfiguration>;
  clearWeChatConfig(): Promise<MyrmeciaWeChatConfiguration>;
  getWorkspace(): Promise<MyrmeciaWorkspaceConfiguration>;
  selectWorkspace(): Promise<MyrmeciaWorkspaceConfiguration>;
  clearWorkspace(): Promise<MyrmeciaWorkspaceConfiguration>;
  restartLocalServer(): void;
}

interface MyrmeciaRuntimeConfiguration {
  provider: 'openai-compatible' | 'deepseek' | 'copilot';
  baseUrl: string;
  model: string;
  apiKeyConfigured: boolean;
  secureStorageAvailable: boolean;
  recoveryMessage?: string;
}

interface MyrmeciaWorkspaceConfiguration {
  available: true;
  configured: boolean;
  path: string;
  name: string;
  isGitRepository: boolean;
}

interface Window {
  myrmeciaDesktopIntegrations?: MyrmeciaDesktopIntegrations;
}
