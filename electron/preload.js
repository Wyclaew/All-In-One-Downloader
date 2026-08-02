'use strict'

const { contextBridge, ipcRenderer } = require('electron')

/** Wrap an event channel so the renderer gets a clean unsubscribe function. */
function on(channel, handler) {
  const listener = (_event, payload) => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,

  getState: () => ipcRenderer.invoke('app:state'),
  getTools: () => ipcRenderer.invoke('tools:get'),
  refreshTools: () => ipcRenderer.invoke('tools:refresh'),
  updateYtdlp: () => ipcRenderer.invoke('tools:update'),
  listBrowsers: () => ipcRenderer.invoke('browsers:list'),

  addSource: (url) => ipcRenderer.invoke('source:add', url),
  removeSource: (id) => ipcRenderer.invoke('source:remove', id),
  toggleSource: (id, collapsed) => ipcRenderer.invoke('source:toggle', { id, collapsed }),
  rescanSource: (id) => ipcRenderer.invoke('source:rescan', id),
  openSource: (id) => ipcRenderer.invoke('source:open', id),
  downloadSource: (payload) => ipcRenderer.invoke('source:downloadAll', payload),

  removeItem: (id) => ipcRenderer.invoke('item:remove', id),
  openItem: (id) => ipcRenderer.invoke('item:open', id),
  download: (payload) => ipcRenderer.invoke('dl:add', payload),

  pause: (id) => ipcRenderer.invoke('dl:pause', id),
  resume: (id) => ipcRenderer.invoke('dl:resume', id),
  cancel: (id) => ipcRenderer.invoke('dl:cancel', id),
  retry: (id) => ipcRenderer.invoke('dl:retry', id),
  removeDownload: (id, deleteFile) => ipcRenderer.invoke('dl:remove', { id, deleteFile }),
  setDownloadCategory: (ids, categoryId) =>
    ipcRenderer.invoke('dl:category', { ids, categoryId }),
  clearDownloads: (which) => ipcRenderer.invoke('dl:clear', which),

  addCategory: (name) => ipcRenderer.invoke('cat:add', name),
  renameCategory: (id, name) => ipcRenderer.invoke('cat:rename', { id, name }),
  removeCategory: (id) => ipcRenderer.invoke('cat:remove', id),

  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  pickDownloadDir: () => ipcRenderer.invoke('settings:pickDir'),
  resetSettings: () => ipcRenderer.invoke('settings:reset'),

  searchSubtitles: (payload) => ipcRenderer.invoke('subs:search', payload),
  applySubtitle: (payload) => ipcRenderer.invoke('subs:apply', payload),
  subtitleTools: () => ipcRenderer.invoke('subs:tools'),

  openFile: (p) => ipcRenderer.invoke('file:open', p),
  revealFile: (p) => ipcRenderer.invoke('file:reveal', p),
  openExternal: (url) => ipcRenderer.invoke('shell:external', url),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),

  onState: (handler) => on('state', handler),
  onProgress: (handler) => on('progress', handler),
  onToast: (handler) => on('toast', handler),
  onFinished: (handler) => on('finished', handler),
  onMenu: (handler) => on('menu', handler),
})
