import { ipcContract } from '@assetforge/contracts';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { AssetForgeApi } from '../src/preload/api';
import { KNOWN_CHANNELS } from '../src/preload/channels.js';

const bridge = vi.hoisted(() => ({
  exposed: new Map<string, unknown>(),
  invoke: vi.fn(async (channel: string) => ({ ok: true, value: channel })),
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (key: string, value: unknown) => bridge.exposed.set(key, value) },
  ipcRenderer: { invoke: bridge.invoke },
}));

let api: AssetForgeApi;

beforeAll(async () => {
  await import('../src/preload/index.js');
  api = bridge.exposed.get('assetForge') as AssetForgeApi;
});

describe('preload channel allowlist', () => {
  it('lists exactly the channels of the contract', () => {
    expect(Object.keys(KNOWN_CHANNELS).sort()).toEqual(Object.keys(ipcContract).sort());
  });

  it('forwards a channel of the contract to the main process', async () => {
    expect(await api.invoke('workspace:list', {})).toEqual({ ok: true, value: 'workspace:list' });
    expect(bridge.invoke).toHaveBeenCalledWith('workspace:list', {});
  });

  it.each(['fs:readAnything', 'toString', '__proto__', ''])(
    'answers %j as an unknown channel without sending it',
    async (channel) => {
      bridge.invoke.mockClear();
      const invoke = api.invoke as (channel: string, request: unknown) => Promise<unknown>;
      expect(await invoke(channel, {})).toEqual({
        ok: false,
        error: { code: 'unknown_channel', message: 'Unknown IPC channel' },
      });
      expect(bridge.invoke).not.toHaveBeenCalled();
    },
  );
});
