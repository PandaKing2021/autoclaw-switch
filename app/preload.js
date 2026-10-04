const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  queryStatus: () => ipcRenderer.invoke("status:query"),
  relayStart: () => ipcRenderer.invoke("relay:start"),
  relayStop: () => ipcRenderer.invoke("relay:stop"),
  watcherStart: () => ipcRenderer.invoke("watcher:start"),
  watcherStop: () => ipcRenderer.invoke("watcher:stop"),
  refreshPoints: () => ipcRenderer.invoke("points:refresh"),
  registerZcode: () => ipcRenderer.invoke("zcode:register"),
  syncCredential: () => ipcRenderer.invoke("credential:sync"),
  smokeTest: () => ipcRenderer.invoke("smoke:test"),
  tailLog: (which) => ipcRenderer.invoke("logs:tail", which),
});
