const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('myrmeciaDesktopIntegrations', {
  getWeChatConfig: () => ipcRenderer.invoke('desktop:get-wechat-config'),
  saveWeChatConfig: configuration => ipcRenderer.invoke('desktop:save-wechat-config', configuration),
  clearWeChatConfig: () => ipcRenderer.invoke('desktop:clear-wechat-config'),
  getWorkspace: () => ipcRenderer.invoke('desktop:get-workspace'),
  selectWorkspace: () => ipcRenderer.invoke('desktop:select-workspace'),
  clearWorkspace: () => ipcRenderer.invoke('desktop:clear-workspace'),
  restartLocalServer: () => ipcRenderer.send('desktop:restart-local-server'),
});
