import type { AppServices, HostActions } from '../src/main/ipc.js';
import type { JobHost } from '../src/main/job-host.js';

/** A job host that never runs a job, for tests that do not exercise jobs. */
export const idleJobHost: JobHost = {
  workspaceOpened: async () => {},
  workspaceClosing: async () => {},
  changes: () => 0,
  changed: () => {},
  wake: () => {},
  cancel: async () => {},
  paused: () => null,
  resume: () => {},
};

/** App services without a provider, for tests that do not exercise settings or describe. */
export const idleServices: AppServices = {
  settings: {
    'settings:getVision': async () => ({
      baseUrl: null,
      timeoutSeconds: 120,
      taggingModel: null,
      promptModel: null,
      hasApiKey: false,
      fromEnvironment: false,
      canStoreKey: false,
    }),
    'settings:setVision': async () => {
      throw new Error('Not used in this test');
    },
    'settings:listVisionModels': async () => ({ ok: false, code: 'provider_not_configured' }),
  },
  describe: {
    describe: async () => ({ ok: false, code: 'provider_not_configured' }),
    cancel: () => {},
    cancelAll: async () => {},
  },
};

/** Host actions that do nothing. */
export const noopHost: HostActions = {
  openPath: async () => '',
  showItemInFolder: () => {},
  workspaceOpened: async () => {},
  workspaceClosing: async () => {},
};
