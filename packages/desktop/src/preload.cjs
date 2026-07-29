const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('myrmeciaDesktop', {
  getStartupState: () => ipcRenderer.invoke('desktop:get-startup-state'),
  onStartupStateChange: listener => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on('desktop:startup-state-changed', handler);
    return () => ipcRenderer.removeListener('desktop:startup-state-changed', handler);
  },
  retryStartup: () => ipcRenderer.send('desktop:retry-startup'),
  runDoctor: () => ipcRenderer.invoke('desktop:run-doctor'),
  getRuntimeConfig: () => ipcRenderer.invoke('desktop:get-runtime-config'),
  saveRuntimeConfig: configuration => ipcRenderer.invoke('desktop:save-runtime-config', configuration),
  continueStartup: () => ipcRenderer.send('desktop:continue-startup'),
  quit: () => ipcRenderer.invoke('desktop:quit'),
});
