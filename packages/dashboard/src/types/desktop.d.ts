interface MyrmeciaWeChatConfiguration {
  available: true;
  configured: boolean;
  appId: string;
  secureStorageAvailable: boolean;
  recoveryMessage?: string;
}

interface MyrmeciaDesktopIntegrations {
  getWeChatConfig(): Promise<MyrmeciaWeChatConfiguration>;
  saveWeChatConfig(input: { appId: string; appSecret: string }): Promise<MyrmeciaWeChatConfiguration>;
  clearWeChatConfig(): Promise<MyrmeciaWeChatConfiguration>;
  getWorkspace(): Promise<MyrmeciaWorkspaceConfiguration>;
  selectWorkspace(): Promise<MyrmeciaWorkspaceConfiguration>;
  clearWorkspace(): Promise<MyrmeciaWorkspaceConfiguration>;
  restartLocalServer(): void;
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
