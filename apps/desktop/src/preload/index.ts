import { contextBridge, ipcRenderer } from 'electron';
import type { AssetForgeApi } from './api';

// Sandboxed preload: only `electron` may be required at runtime. Requests are
// validated in main (`dispatch`), never here.
/** The bridge exposed to the renderer: one generic invoke. */
const api: AssetForgeApi = {
  invoke: (channel, request) => ipcRenderer.invoke(channel, request),
};

contextBridge.exposeInMainWorld('assetForge', api);
