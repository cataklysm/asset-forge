import { contextBridge, ipcRenderer } from 'electron';
import type { AssetForgeApi } from './api';
import { isKnownChannel } from './channels';

// Sandboxed preload: only `electron` may be required at runtime. Requests are
// validated in main (`dispatch`), never here; the preload only refuses a channel
// the contract does not know, with the same answer main would give.

/** The answer for a channel outside the contract, equal to the one of `dispatch` in main. */
const UNKNOWN_CHANNEL = { ok: false, error: { code: 'unknown_channel', message: 'Unknown IPC channel' } } as const;

/** The bridge exposed to the renderer: one generic invoke over the channels of the contract. */
const api: AssetForgeApi = {
  invoke: (channel, request) =>
    isKnownChannel(channel) ? ipcRenderer.invoke(channel, request) : Promise.resolve(UNKNOWN_CHANNEL),
};

contextBridge.exposeInMainWorld('assetForge', api);
