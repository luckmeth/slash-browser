const { contextBridge, ipcRenderer } = require('electron')

/**
 * The setup screen's only capabilities.
 *
 * Four channels, all invoked by a page shipped inside this app — nothing web-
 * facing ever loads with this preload attached, because the moment the server
 * is up the window navigates to it and gets a fresh renderer.
 *
 * `current` deliberately cannot return a secret: main answers it with whether
 * a key is stored, never the key. The screen has no need for the value and
 * this renderer has no business holding one.
 */
contextBridge.exposeInMainWorld('operations', {
  current: () => ipcRenderer.invoke('setup:current'),
  save: (fields) => ipcRenderer.invoke('setup:save', fields),
  cancel: () => ipcRenderer.invoke('setup:cancel'),
  forget: () => ipcRenderer.invoke('setup:forget')
})
