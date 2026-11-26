import type { IpcHandlers } from './ipc.js';
import type { VisionGateway } from './vision-gateway.js';
import type { VisionSettingsStore } from './vision-settings.js';

// Kept free of Electron imports. App-level settings: no open workspace is needed.

export type SettingsHandlers = Pick<IpcHandlers, 'settings:getVision' | 'settings:setVision' | 'settings:listVisionModels'>;

export function createSettingsHandlers(store: VisionSettingsStore, gateway: VisionGateway): SettingsHandlers {
  return {
    'settings:getVision': async () => store.view(),
    'settings:setVision': async (r) => store.save(r),
    // There is no cancel channel; the adapter's own timeouts bound the request.
    'settings:listVisionModels': (r) => gateway.models(r.refresh === true, new AbortController().signal),
  };
}
