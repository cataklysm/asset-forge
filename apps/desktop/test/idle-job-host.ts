import { randomUUID } from 'node:crypto';
import { builtInAnalysisPrompt } from '@assetforge/core';
import { createAnalysisPromptHandlers } from '../src/main/analysis-prompt-handlers.js';
import { createAnalysisPromptStore } from '../src/main/analysis-prompts.js';
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

function notUsed(): never {
  throw new Error('Not used in this test');
}

/** App services without a provider, for tests that do not exercise settings, analysis prompts or describe. */
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
  analysisPrompts: {
    'analysisPrompts:list': notUsed,
    'analysisPrompts:save': notUsed,
    'analysisPrompts:delete': notUsed,
    'analysisPrompts:reset': notUsed,
  },
  prompts: {
    list: notUsed,
    save: notUsed,
    remove: notUsed,
    reset: notUsed,
    resolve: notUsed,
    markUsed: () => {},
  },
  describe: {
    describe: async () => ({ ok: false, code: 'provider_not_configured' }),
    cancel: () => {},
    cancelAll: async () => {},
    block: () => {},
    unblock: () => {},
  },
};

/** The idle services with a real analysis prompt store in `userData`, for tests that enqueue analyses. */
export function servicesWithPrompts(userData: string, log: (line: string) => void = () => {}): AppServices {
  const prompts = createAnalysisPromptStore({ userData, newId: randomUUID, builtIn: builtInAnalysisPrompt, log });
  return { ...idleServices, prompts, analysisPrompts: createAnalysisPromptHandlers(prompts) };
}

/** Host actions that do nothing. */
export const noopHost: HostActions = {
  openPath: async () => '',
  showItemInFolder: () => {},
  openExternal: async () => {},
  workspaceOpened: async () => {},
  workspaceClosing: async () => {},
};
