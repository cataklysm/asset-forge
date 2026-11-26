import { randomUUID } from 'node:crypto';
import type { ProviderView } from '@assetforge/contracts';
import { builtInAnalysisPrompt, type VisionProvider } from '@assetforge/core';
import { createOllamaVision } from '@assetforge/providers';
import { createAnalysisPromptHandlers } from '../src/main/analysis-prompt-handlers.js';
import { createAnalysisPromptStore } from '../src/main/analysis-prompts.js';
import type { AppServices, HostActions } from '../src/main/ipc.js';
import type { JobHost } from '../src/main/job-host.js';
import { createProviderGateway } from '../src/main/provider-gateway.js';
import { createProviderStore, type ProviderStore } from '../src/main/provider-store.js';
import { FakeCodec } from './fake-codec.js';

/** A job host that never runs a job, for tests that do not exercise jobs. */
export const idleJobHost: JobHost = {
  workspaceOpened: async () => {},
  workspaceClosing: async () => {},
  changes: () => 0,
  changed: () => {},
  wake: () => {},
  cancel: async () => {},
  paused: () => [],
  resume: () => {},
};

function notUsed(): never {
  throw new Error('Not used in this test');
}

/** App services without a provider, for tests that do not exercise settings, analysis prompts or describe. */
export const idleServices: AppServices = {
  providers: {
    'providers:list': async () => ({ providers: [], lastUsedId: null, fromEnvironment: false, canStoreKey: false }),
    'providers:save': notUsed,
    'providers:delete': notUsed,
    'providers:listModels': notUsed,
  },
  providerStore: {
    list: () => ({ providers: [], lastUsedId: null, fromEnvironment: false, canStoreKey: false }),
    get: () => null,
    first: () => null,
    resolve: () => null,
    markUsed: () => {},
    save: notUsed,
    delete: notUsed,
    apiKeyFor: () => null,
    onChange: () => {},
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

/**
 * The idle services with a real analysis prompt store in `userData`, for tests that enqueue analyses; with
 * `providerStore`, analyses resolve their provider entry there.
 */
export function servicesWithPrompts(
  userData: string,
  log: (line: string) => void = () => {},
  providerStore: ProviderStore = idleServices.providerStore,
): AppServices {
  const prompts = createAnalysisPromptStore({ userData, newId: randomUUID, builtIn: builtInAnalysisPrompt, log });
  return { ...idleServices, prompts, analysisPrompts: createAnalysisPromptHandlers(prompts), providerStore };
}

/** A real provider store in `userData` with one entry named `Mock` for `url` without a key, and its gateway. */
export function mockProviderEntry(
  userData: string,
  url: string,
): { store: ProviderStore; entry: ProviderView; vision: (lane: string | null) => VisionProvider | null } {
  const store = createProviderStore({ userData, secrets: new FakeCodec(), env: {} });
  const gateway = createProviderGateway({ store, create: createOllamaVision, log: () => {} });
  const entry = store.save({ name: 'Mock', baseUrl: url, timeoutSeconds: 30, taggingModel: null, promptModel: null });
  return { store, entry, vision: (lane) => gateway.vision(lane) };
}

/** Host actions that do nothing. */
export const noopHost: HostActions = {
  openPath: async () => '',
  showItemInFolder: () => {},
  openExternal: async () => {},
  workspaceOpened: async () => {},
  workspaceClosing: async () => {},
};
