const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('myrmeciaDesktopIntegrations', {
  getRuntimeConfig: () => ipcRenderer.invoke('desktop:get-runtime-config'),
  saveRuntimeConfig: configuration => ipcRenderer.invoke('desktop:save-runtime-config', configuration),
  getWeChatConfig: () => ipcRenderer.invoke('desktop:get-wechat-config'),
  saveWeChatConfig: configuration => ipcRenderer.invoke('desktop:save-wechat-config', configuration),
  clearWeChatConfig: () => ipcRenderer.invoke('desktop:clear-wechat-config'),
  getWorkspace: () => ipcRenderer.invoke('desktop:get-workspace'),
  selectWorkspace: () => ipcRenderer.invoke('desktop:select-workspace'),
  clearWorkspace: () => ipcRenderer.invoke('desktop:clear-workspace'),
  restartLocalServer: () => ipcRenderer.send('desktop:restart-local-server'),
});
