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
  restartLocalServer(): void;
}

interface Window {
  myrmeciaDesktopIntegrations?: MyrmeciaDesktopIntegrations;
}
