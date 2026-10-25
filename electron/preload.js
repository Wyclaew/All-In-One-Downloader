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

  addSource: (input, useProxy) => ipcRenderer.invoke('source:add', { input, useProxy }),
  checkProxy: () => ipcRenderer.invoke('proxy:check'),
  proxyPresets: () => ipcRenderer.invoke('proxy:presets'),

  torStatus: () => ipcRenderer.invoke('tor:status'),
  torStart: () => ipcRenderer.invoke('tor:start'),
  torStop: () => ipcRenderer.invoke('tor:stop'),
  removeSource: (id) => ipcRenderer.invoke('source:remove', id),
  toggleSource: (id, collapsed) => ipcRenderer.invoke('source:toggle', { id, collapsed }),
  rescanSource: (id) => ipcRenderer.invoke('source:rescan', id),
  captureSource: (id) => ipcRenderer.invoke('source:capture', id),
  setSourceProxy: (id, useProxy) => ipcRenderer.invoke('source:proxy', { id, useProxy }),
  cancelSource: (id) => ipcRenderer.invoke('source:cancel', id),
  refreshSourceMetadata: (id) => ipcRenderer.invoke('source:metadata', id),
  sourceDiagnostics: (id) => ipcRenderer.invoke('source:diagnostics', id),
  retryFailedSources: () => ipcRenderer.invoke('source:retryFailed'),
  cancelAllSources: () => ipcRenderer.invoke('source:cancelAll'),
  openSource: (id) => ipcRenderer.invoke('source:open', id),
  downloadSource: (payload) => ipcRenderer.invoke('source:downloadAll', payload),

  removeItem: (id) => ipcRenderer.invoke('item:remove', id),
  openItem: (id) => ipcRenderer.invoke('item:open', id),
  download: (payload) => ipcRenderer.invoke('dl:add', payload),

  prioritizeDownload: (id) => ipcRenderer.invoke('dl:prioritize', id),
  backupLibrary: () => ipcRenderer.invoke('settings:backup'),
  siteAccountsStatus: () => ipcRenderer.invoke('accounts:status'),
  saveSiteAccountProfile: (profile) => ipcRenderer.invoke('accounts:profile:set', profile),
  clearSiteAccountProfile: () => ipcRenderer.invoke('accounts:profile:clear'),
  setSiteAccountPolicy: (policy) => ipcRenderer.invoke('accounts:site:set', policy),
  removeSiteAccountPolicy: (origin) => ipcRenderer.invoke('accounts:site:remove', origin),
  pause: (id) => ipcRenderer.invoke('dl:pause', id),
  resume: (id) => ipcRenderer.invoke('dl:resume', id),
  cancel: (id) => ipcRenderer.invoke('dl:cancel', id),
  retry: (id) => ipcRenderer.invoke('dl:retry', id),
  removeDownload: (id, deleteFile) => ipcRenderer.invoke('dl:remove', { id, deleteFile }),
  removeDownloads: (ids, deleteFile) => ipcRenderer.invoke('dl:removeMany', { ids, deleteFile }),
  verifyDownloads: () => ipcRenderer.invoke('dl:verify'),
  redownload: (id) => ipcRenderer.invoke('dl:redownload', id),
  clearMissing: () => ipcRenderer.invoke('dl:clearMissing'),
  thumbFile: (path, duration) => ipcRenderer.invoke('thumb:file', { path, duration }),
  tidyFolder: () => ipcRenderer.invoke('folder:tidy'),
  setDownloadSeries: (id, series) => ipcRenderer.invoke('dl:series', { id, series }),
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

  listScripts: () => ipcRenderer.invoke('scripts:list'),
  openScripts: () => ipcRenderer.invoke('scripts:open'),

  // The passphrase goes one way only: in. Nothing here can read it back out.
  vaultStatus: () => ipcRenderer.invoke('vault:status'),
  vaultCreate: (passphrase) => ipcRenderer.invoke('vault:create', passphrase),
  vaultUnlock: (passphrase) => ipcRenderer.invoke('vault:unlock', passphrase),
  vaultSetBiometric: (enabled) => ipcRenderer.invoke('vault:biometric:set', enabled),
  vaultUnlockBiometric: () => ipcRenderer.invoke('vault:biometric:unlock'),
  openTouchIdSettings: () => ipcRenderer.invoke('vault:touchIdSettings'),
  vaultLock: () => ipcRenderer.invoke('vault:lock'),
  vaultChangePassphrase: (current, next) => ipcRenderer.invoke('vault:changePassphrase', { current, next }),
  vaultTakeDownload: (id) => ipcRenderer.invoke('vault:takeDownload', id),
  vaultAddFiles: () => ipcRenderer.invoke('vault:addFiles'),
  vaultOpen: (id) => ipcRenderer.invoke('vault:open', id),
  vaultOpenExternal: (id) => ipcRenderer.invoke('vault:openExternal', id),
  vaultExport: (id) => ipcRenderer.invoke('vault:export', id),
  vaultRemove: (id) => ipcRenderer.invoke('vault:remove', id),

  openFile: (p) => ipcRenderer.invoke('file:open', p),
  playFile: (p) => ipcRenderer.invoke('file:play', p),
  revealFile: (p) => ipcRenderer.invoke('file:reveal', p),
  openExternal: (url) => ipcRenderer.invoke('shell:external', url),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  writeClipboard: (text) => ipcRenderer.invoke('clipboard:write', text),

  onState: (handler) => on('state', handler),
  onVault: (handler) => on('vault', handler),
  onProgress: (handler) => on('progress', handler),
  onOutlook: (handler) => on('outlook', handler),
  onTor: (handler) => on('tor', handler),
  onUpdate: (handler) => on('update', handler),
  updateStatus: () => ipcRenderer.invoke('update:status'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateInstall: () => ipcRenderer.invoke('update:install'),
  updateSetToken: (value) => ipcRenderer.invoke('update:setToken', value),
  onToast: (handler) => on('toast', handler),
  onFinished: (handler) => on('finished', handler),
  onMenu: (handler) => on('menu', handler),
})
