/**
 * Preload entry for the agent-browser pane chrome page (tabs + address bar).
 *
 * The strip is its own webContents, not the Harness page, so it gets its own entry
 * and the narrowest possible surface: read the pane state, report one named gesture,
 * subscribe to pushes. No generic `invoke(channel, ...args)` is exposed.
 */
import { contextBridge, ipcRenderer } from 'electron'
import { createAgentBrowserPaneBridge } from './agent-browser-pane-bridge'

contextBridge.exposeInMainWorld(
  'dshAgentBrowserPane',
  createAgentBrowserPaneBridge({
    invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
    on: (channel, listener) => ipcRenderer.on(channel, listener),
    removeListener: (channel, listener) => ipcRenderer.removeListener(channel, listener)
  })
)