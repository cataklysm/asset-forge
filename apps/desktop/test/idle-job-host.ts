import { randomUUID } from 'node:crypto';
import type { ProviderView } from '@assetforge/contracts';
import {
  builtInAnalysisPrompt,
  type GenerationImageSource,
  type ImageProviderDirectory,
  type RemoteFileSource,
  type VisionProvider,
} from '@assetforge/core';
import { createOllamaVision, createOpenAiVision, createVeniceImage } from '@assetforge/providers';
import { createAnalysisPromptHandlers } from '../src/main/analysis-prompt-handlers.js';
import { createAnalysisPromptStore } from '../src/main/analysis-prompts.js';
import type { HostActions } from '../src/main/host-actions.js';
import type { AppServices } from '../src/main/workspace-handlers.js';
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
  changesSince: () => ({ cursor: 'idle:0', reset: true, jobIds: [], jobs: false, fileIds: [], added: [] }),
  wake: () => {},
  cancel: async () => {},
  cancelAll: async () => 0,
  paused: () => [],
  resume: () => {},
};

function notUsed(): never {
  throw new Error('Not used in this test');
}

/** App services without a provider, for tests that do not exercise settings, analysis prompts or describe. */
export const idleServices: AppServices = {
  providers: {
    'providers:list': async () => ({
      providers: [],
      lastUsedId: null,
      lastUsedImageId: null,
      fromEnvironment: false,
      canStoreKey: false,
    }),
    'providers:save': notUsed,
    'providers:delete': notUsed,
    'providers:listModels': notUsed,
    'providers:listImageModels': notUsed,
  },
  imageProviders: noImageProviders(),
  providerStore: {
    list: () => ({
      providers: [],
      lastUsedId: null,
      lastUsedImageId: null,
      fromEnvironment: false,
      canStoreKey: false,
    }),
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
  sites: {
    'sites:list': async () => ({ profiles: [] }),
    'sites:save': notUsed,
    'sites:delete': notUsed,
    'sites:openLogin': notUsed,
    'sites:openCheck': notUsed,
    'sites:crawl': notUsed,
    'sites:crawlProgress': async () => null,
    'sites:cancelCrawl': async () => ({ cancelling: false }),
    'sites:import': notUsed,
    'sites:enqueueCrawl': notUsed,
    'sites:listCrawls': async () => ({ items: [], total: 0 }),
    'sites:getCrawl': notUsed,
    'sites:retryCrawl': notUsed,
    'sites:removeCrawl': notUsed,
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
  const gateway = createProviderGateway({
    store,
    createVision: { ollama: createOllamaVision, openai: createOpenAiVision },
    createImage: createVeniceImage,
    log: () => {},
  });
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

/** An image provider directory without any `venice` entry. */
export function noImageProviders(): ImageProviderDirectory {
  return {
    resolve: () => null,
    exists: () => false,
    adapter: () => null,
    models: async () => ({ ok: false, code: 'provider_not_configured' }),
    markUsed: () => {},
  };
}

/** What `createJobHost` needs for generation jobs in tests that never start one. */
export const noGenerations: { imageProviders: ImageProviderDirectory; generationImages: GenerationImageSource } = {
  imageProviders: noImageProviders(),
  generationImages: { read: async () => null },
};

/** A remote source for tests that never fetch: every open waits until its job is aborted. */
export const hangingRemote: RemoteFileSource = {
  open: (_url, signal) =>
    new Promise((_resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
};
