const { contextBridge, ipcRenderer } = require('electron')

/**
 * The setup screen's only capability.
 *
 * Two channels, both invoked by a page shipped inside this app — nothing web-
 * facing ever loads with this preload attached, because the moment the server
 * is up the window navigates to it and gets a fresh renderer.
 */
contextBridge.exposeInMainWorld('operations', {
  save: (key) => ipcRenderer.invoke('setup:save', key),
  forget: () => ipcRenderer.invoke('setup:forget')
})
