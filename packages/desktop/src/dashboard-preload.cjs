const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('myrmeciaDesktopIntegrations', {
  getWeChatConfig: () => ipcRenderer.invoke('desktop:get-wechat-config'),
  saveWeChatConfig: configuration => ipcRenderer.invoke('desktop:save-wechat-config', configuration),
  clearWeChatConfig: () => ipcRenderer.invoke('desktop:clear-wechat-config'),
  restartLocalServer: () => ipcRenderer.send('desktop:restart-local-server'),
});
