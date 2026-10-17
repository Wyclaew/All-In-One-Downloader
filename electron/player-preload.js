'use strict'

// The player window's only bridge.
//
// The page it serves is ours and loads no remote content, but it is still a
// document rendering a file whose contents came off the internet — so the surface
// it can reach is this list and nothing else. There is no way from here to a
// path, a setting, or another window: the main process already knows which file
// this window is playing, and every call is answered in terms of that file.

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('aioPlayer', {
  /** Title, media address, resume point, and the subtitle tracks we could find. */
  boot: () => ipcRenderer.invoke('player:boot'),

  /** Re-scan for subtitle files that appeared beside the video since we opened. */
  tracks: () => ipcRenderer.invoke('player:tracks'),

  /** The cues of one track, parsed in the main process. */
  cues: (trackId) => ipcRenderer.invoke('player:cues', trackId),

  /** Ask OpenSubtitles for this file, in this language, right now. */
  searchSubtitles: (language) => ipcRenderer.invoke('player:searchSubtitles', language),

  /** Take one of the hits the search came back with. */
  takeSubtitle: (fileId) => ipcRenderer.invoke('player:takeSubtitle', fileId),

  /** Switch this window over to the next or previous episode in the same folder. */
  next: () => ipcRenderer.invoke('player:next'),
  prev: () => ipcRenderer.invoke('player:prev'),

  /** Speed, picture fit, audio boost, auto-next, subtitle style — validated in main. */
  prefs: (prefs) => ipcRenderer.send('player:prefs', prefs),

  /** Keep the window above others. */
  onTop: (on) => ipcRenderer.invoke('player:onTop', !!on),

  /** Save the current frame (a PNG data URL) to Pictures. Refused for the vault. */
  screenshot: (dataUrl, at) => ipcRenderer.invoke('player:screenshot', { dataUrl, at }),

  /** A subtitle nudged into place stays there, for this file. */
  setDelay: (seconds) => ipcRenderer.send('player:delay', seconds),

  /** Volume is a setting, not a per-window whim. */
  setVolume: (value) => ipcRenderer.send('player:volume', value),

  /** Rewrap a container Chromium cannot open, without re-encoding anything. */
  remux: () => ipcRenderer.invoke('player:remux'),

  /** Hand the file to the system player instead. */
  openExternally: () => ipcRenderer.invoke('player:openExternally'),

  /** Subtitle size is a setting, not a per-window whim. */
  subtitleSize: (size) => ipcRenderer.invoke('player:subtitleSize', size),

  /**
   * Remember the position. Called while playing and once on the way out, because
   * a window closed with the mouse never gets a chance to report anything later.
   */
  remember: (seconds, duration) => ipcRenderer.send('player:position', { seconds, duration }),
})
