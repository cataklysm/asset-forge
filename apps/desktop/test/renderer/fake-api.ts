import type {
  AnalysisPrompt,
  AnalysisPromptList,
  AssetDetail,
  Changes,
  ErrorCode,
  FileOrigin,
  ImportResult,
  IpcChannel,
  IpcRequest,
  IpcResponse,
  IpcResult,
  ListModelsResult,
  PromptDetail,
  PromptSummary,
  ProviderList,
  ProviderView,
  UrlImportResult,
} from '@assetforge/contracts';
import {
  DEFAULT_PROVIDER_OPTIONS,
  buildPromptVariables,
  cleanTagText,
  extraParametersMessage,
  isVisionKind,
  normalizeTagName,
  parseExtraParameters,
} from '@assetforge/contracts';
import {
  BUILT_IN_IMAGE_PROMPT_TEXT,
  BUILT_IN_TAGGING_TEXT,
  imagePrompt,
  nextId,
  taggingPrompt,
} from './fixtures';

export type FakeHandlers = {
  [C in IpcChannel]?: (request: IpcRequest<C>) => IpcResponse<C> | Promise<IpcResponse<C>>;
};

class FakeError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function fakeError(code: ErrorCode, message: string = code): Error {
  return new FakeError(code, message);
}

export function deferred<T>(): {
  promise: Promise<T>;
  resolve(v: T): void;
  reject(e: unknown): void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * One result of `files:import`: no file, no error, no duplicates unless given. For an archive
 * entry pass `entryName`; `sourcePath` is then the archive's path.
 */
export function importResultOf(sourcePath: string, p: Partial<Omit<ImportResult, 'sourcePath'>> = {}): ImportResult {
  return { sourcePath, entryName: null, file: null, error: null, duplicateOf: [], ...p };
}

/** One answer of `files:importUrls`: nothing queued or skipped unless given. */
export function urlImportResultOf(p: Partial<UrlImportResult> = {}): UrlImportResult {
  return { queued: 0, alreadyImported: 0, alreadyQueued: 0, invalid: [], ...p };
}

type PromptChannel = 'analysisPrompts:list' | 'analysisPrompts:save' | 'analysisPrompts:delete' | 'analysisPrompts:reset';

/**
 * In-memory handlers for the `analysisPrompts:*` channels, refusing what the main process refuses
 * with its fixed messages. Seeded with a `Default` per purpose unless `seed` is given.
 */
export function fakeAnalysisPrompts(seed?: Partial<AnalysisPromptList>): {
  state: AnalysisPromptList;
  handlers: { [C in PromptChannel]: NonNullable<FakeHandlers[C]> };
} {
  const state: AnalysisPromptList = {
    prompts: seed?.prompts ?? [taggingPrompt(), imagePrompt()],
    lastUsed: seed?.lastUsed ?? { tagging: null, imagePrompt: null },
  };
  const find = (id: string) => {
    const prompt = state.prompts.find((p) => p.id === id);
    if (prompt === undefined) throw fakeError('not_found', 'The analysis prompt does not exist');
    return prompt;
  };
  const replace = (next: AnalysisPrompt) => {
    state.prompts = state.prompts.map((p) => (p.id === next.id ? next : p));
    return next;
  };
  const handlers: { [C in PromptChannel]: NonNullable<FakeHandlers[C]> } = {
    'analysisPrompts:list': () => structuredClone(state),
    'analysisPrompts:save': (request) => {
      const name = request.name.trim();
      const taken = state.prompts.some(
        (p) => p.purpose === request.purpose && p.id !== request.id && p.name.trim().toLowerCase() === name.toLowerCase(),
      );
      if (taken) throw fakeError('invalid_operation', 'An analysis prompt with this name already exists');
      const next = { ...request, id: request.id ?? nextId(), name, text: request.text.trim() } as AnalysisPrompt;
      if (request.id === undefined) {
        state.prompts = [...state.prompts, next];
        return next;
      }
      if (find(request.id).purpose !== request.purpose)
        throw fakeError('invalid_operation', 'The purpose of an analysis prompt cannot be changed');
      return replace(next);
    },
    'analysisPrompts:delete': ({ id }) => {
      const prompt = find(id);
      if (state.prompts.filter((p) => p.purpose === prompt.purpose).length === 1)
        throw fakeError('invalid_operation', 'The last analysis prompt of a purpose cannot be deleted');
      state.prompts = state.prompts.filter((p) => p.id !== id);
      if (state.lastUsed.tagging === id) state.lastUsed.tagging = null;
      if (state.lastUsed.imagePrompt === id) state.lastUsed.imagePrompt = null;
      return {};
    },
    'analysisPrompts:reset': ({ id }) => {
      const prompt = find(id);
      return replace(
        prompt.purpose === 'tagging'
          ? { ...prompt, text: BUILT_IN_TAGGING_TEXT, maxTags: 15 }
          : { ...prompt, text: BUILT_IN_IMAGE_PROMPT_TEXT },
      );
    },
  };
  return { state, handlers };
}

type ProviderChannel = 'providers:list' | 'providers:save' | 'providers:delete' | 'providers:listModels' | 'providers:listImageModels';

/** A stored provider entry: `Local` on the mock address, with a tagging and a prompt model and no key. */
export function providerView(p: Partial<ProviderView> = {}): ProviderView {
  const kind = p.kind ?? 'ollama';
  return {
    id: nextId(),
    kind,
    name: 'Local',
    baseUrl: 'http://127.0.0.1:11500',
    timeoutSeconds: 120,
    taggingModel: 'vision-a',
    promptModel: 'vision-a',
    editModel: null,
    hasApiKey: false,
    options: isVisionKind(kind) ? { ...DEFAULT_PROVIDER_OPTIONS } : null,
    ...p,
  };
}

/** The model list a fake entry answers unless `models` names another for it. */
export const FAKE_MODELS: ListModelsResult = { ok: true, models: [{ name: 'vision-a', vision: true }] };

/**
 * In-memory handlers for the `providers:*` channels, refusing what the main process refuses with
 * its fixed messages. Empty unless `seed` is given; `models` answers `providers:listModels` per
 * entry id (a function may return a pending promise), every other listed entry answers `FAKE_MODELS`.
 */
export function fakeProviders(
  seed?: Partial<ProviderList>,
  models: Record<string, ListModelsResult | (() => ListModelsResult | Promise<ListModelsResult>)> = {},
): {
  state: ProviderList;
  handlers: { [C in ProviderChannel]: NonNullable<FakeHandlers[C]> };
} {
  const state: ProviderList = {
    providers: seed?.providers ?? [],
    lastUsedId: seed?.lastUsedId ?? null,
    lastUsedImageId: seed?.lastUsedImageId ?? null,
    fromEnvironment: seed?.fromEnvironment ?? false,
    canStoreKey: seed?.canStoreKey ?? true,
  };
  const find = (id: string) => {
    const entry = state.providers.find((p) => p.id === id);
    if (entry === undefined) throw fakeError('not_found', 'This provider does not exist');
    return entry;
  };
  const handlers: { [C in ProviderChannel]: NonNullable<FakeHandlers[C]> } = {
    'providers:list': () => structuredClone(state),
    'providers:save': (request) => {
      if (state.fromEnvironment)
        throw fakeError('invalid_operation', 'The provider settings are set by the environment and cannot be changed');
      const name = request.name.trim();
      if (name.length < 1 || name.length > 60) throw fakeError('validation_failed', 'The provider name must have 1 to 60 characters');
      if (state.providers.some((p) => p.id !== request.id && p.name.toLowerCase() === name.toLowerCase()))
        throw fakeError('invalid_operation', 'A provider with this name already exists');
      const before = request.id === undefined ? undefined : find(request.id);
      if (before === undefined && state.providers.length >= 10) throw fakeError('invalid_operation', 'No more than 10 providers');
      if (before !== undefined && request.kind !== undefined && request.kind !== before.kind)
        throw fakeError('invalid_operation', 'The kind of a provider cannot be changed');
      const kind = before?.kind ?? request.kind ?? 'ollama';
      const editModel = request.editModel === undefined ? (before?.editModel ?? null) : request.editModel;
      // Absent options keep the stored ones, a new vision entry gets the defaults; venice has none.
      let options: ProviderView['options'] = null;
      if (isVisionKind(kind)) {
        options = request.options ?? before?.options ?? { ...DEFAULT_PROVIDER_OPTIONS };
        const extra = parseExtraParameters(options.extra, kind);
        if (!extra.ok) throw fakeError('validation_failed', extraParametersMessage(extra));
      }
      // A venice entry keeps no vision models and no options, a vision entry no edit model.
      const next: ProviderView = {
        id: before?.id ?? nextId(),
        kind,
        name,
        baseUrl: request.baseUrl,
        timeoutSeconds: request.timeoutSeconds,
        taggingModel: kind === 'venice' ? null : request.taggingModel,
        promptModel: kind === 'venice' ? null : request.promptModel,
        editModel: kind === 'venice' ? editModel : null,
        hasApiKey: request.apiKey === undefined ? (before?.hasApiKey ?? false) : request.apiKey !== null,
        options: options === null ? null : { ...options },
      };
      state.providers = before === undefined ? [...state.providers, next] : state.providers.map((p) => (p.id === next.id ? next : p));
      return structuredClone(next);
    },
    'providers:delete': ({ id }) => {
      find(id);
      state.providers = state.providers.filter((p) => p.id !== id);
      if (state.lastUsedId === id) state.lastUsedId = null;
      if (state.lastUsedImageId === id) state.lastUsedImageId = null;
      return {};
    },
    'providers:listModels': ({ providerId }) => {
      if (!state.providers.some((p) => p.id === providerId)) return { ok: false, code: 'provider_not_configured' };
      const answer = models[providerId] ?? FAKE_MODELS;
      return typeof answer === 'function' ? answer() : structuredClone(answer);
    },
    'providers:listImageModels': ({ providerId }) => {
      const entry = state.providers.find((p) => p.id === providerId);
      if (entry === undefined) return { ok: false, code: 'provider_not_configured' };
      if (entry.kind !== 'venice') throw fakeError('invalid_operation', 'This provider cannot generate images');
      return { ok: true, models: [] };
    },
  };
  return { state, handlers };
}

type SourceChannel = 'assets:get' | 'assets:addSource' | 'assets:removeSource' | 'assets:openSource';

/**
 * In-memory handlers for the source channels of one asset (and its `assets:get`), refusing what the
 * main process refuses with its fixed messages. `opened` records the source IDs asked to be opened.
 */
export function fakeAssetSources(asset: AssetDetail): {
  state: { asset: AssetDetail; opened: string[] };
  handlers: { [C in SourceChannel]: NonNullable<FakeHandlers[C]> };
} {
  const state = { asset: structuredClone(asset), opened: [] as string[] };
  const find = (assetId: string) => {
    if (assetId !== state.asset.id) throw fakeError('not_found', 'The asset does not exist');
    return state.asset;
  };
  const normalised = (text: string) => {
    try {
      const url = new URL(text.trim());
      if ((url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '') return url.href;
    } catch {
      // Falls through to the refusal below.
    }
    throw fakeError('validation_failed', 'This is not a web address');
  };
  const handlers: { [C in SourceChannel]: NonNullable<FakeHandlers[C]> } = {
    'assets:get': ({ id }) => structuredClone(find(id)),
    'assets:addSource': ({ assetId, url }) => {
      const current = find(assetId);
      const href = normalised(url);
      if (current.sources.some((s) => s.url === href)) throw fakeError('invalid_operation', 'This source already exists');
      if (current.sources.length >= 50) throw fakeError('invalid_operation', 'This asset cannot take more sources');
      state.asset = { ...current, sources: [...current.sources, { id: nextId(), url: href, createdAt: current.updatedAt }] };
      return structuredClone(state.asset);
    },
    'assets:removeSource': ({ assetId, sourceId }) => {
      const current = find(assetId);
      if (!current.sources.some((s) => s.id === sourceId)) throw fakeError('not_found', 'The source does not exist');
      state.asset = { ...current, sources: current.sources.filter((s) => s.id !== sourceId) };
      return structuredClone(state.asset);
    },
    'assets:openSource': ({ assetId, sourceId }) => {
      if (!find(assetId).sources.some((s) => s.id === sourceId)) throw fakeError('not_found', 'The source does not exist');
      state.opened.push(sourceId);
      return null;
    },
  };
  return { state, handlers };
}

type OriginChannel = 'files:origins' | 'files:openOrigin';

/**
 * In-memory handlers for the origin channels, keyed by file ID; a file not given has no origins.
 * `opened` records the `{ fileId, originId }` pairs asked to be opened.
 */
export function fakeFileOrigins(origins: Record<string, FileOrigin[]>): {
  state: { opened: { fileId: string; originId: string }[] };
  handlers: { [C in OriginChannel]: NonNullable<FakeHandlers[C]> };
} {
  const state = { opened: [] as { fileId: string; originId: string }[] };
  const handlers: { [C in OriginChannel]: NonNullable<FakeHandlers[C]> } = {
    'files:origins': ({ fileId }) => structuredClone(origins[fileId] ?? []),
    'files:openOrigin': ({ fileId, originId }) => {
      if (!(origins[fileId] ?? []).some((o) => o.id === originId)) throw fakeError('not_found', 'The source does not exist');
      state.opened.push({ fileId, originId });
      return {};
    },
  };
  return { state, handlers };
}

type LibraryChannel =
  | 'prompts:list'
  | 'prompts:get'
  | 'prompts:create'
  | 'prompts:update'
  | 'prompts:saveVersion'
  | 'prompts:delete'
  | 'prompts:addTag'
  | 'prompts:removeTag';

let promptClock = Date.parse('2026-11-27T08:00:00.000Z');
const promptTime = () => new Date((promptClock += 60_000)).toISOString();

/** A stored library prompt with one version (`content`, defaults from `defaults`), or the given versions. */
export function promptDetail(
  p: Partial<Omit<PromptDetail, 'currentVersion' | 'versions'>> & {
    content?: string;
    defaults?: Record<string, string>;
    versions?: PromptDetail['versions'];
  } = {},
): PromptDetail {
  const { content = 'A {{view}} of the subject', defaults = {}, versions, ...rest } = p;
  const createdAt = rest.createdAt ?? promptTime();
  const all = versions ?? [
    { id: nextId(), number: 1, content, variables: buildPromptVariables(content, defaults), createdAt },
  ];
  return {
    id: nextId(),
    title: 'Prompt',
    description: '',
    tags: [],
    updatedAt: all[0]!.createdAt,
    createdAt,
    ...rest,
    currentVersion: all[0]!,
    versions: all,
  };
}

const summaryOf = ({ versions: _versions, createdAt: _createdAt, ...summary }: PromptDetail): PromptSummary => summary;

/**
 * In-memory handlers for the library's `prompts:*` channels, refusing what core refuses with its fixed
 * messages. The list matches `query` in title, description and current text, and needs every tag.
 */
export function fakePrompts(seed: PromptDetail[] = []): {
  state: { prompts: PromptDetail[] };
  handlers: { [C in LibraryChannel]: NonNullable<FakeHandlers[C]> };
} {
  const state = { prompts: structuredClone(seed) };
  const find = (id: string) => {
    const prompt = state.prompts.find((item) => item.id === id);
    if (prompt === undefined) throw fakeError('not_found', 'This prompt does not exist');
    return prompt;
  };
  const store = (next: PromptDetail) => {
    state.prompts = state.prompts.map((item) => (item.id === next.id ? next : item));
    return structuredClone(next);
  };
  const checkTitle = (title: string, id: string | null) => {
    if (title === '') throw fakeError('validation_failed', 'A prompt needs a title');
    if (state.prompts.some((item) => item.id !== id && item.title.toLowerCase() === title.toLowerCase()))
      throw fakeError('validation_failed', 'This title is already used');
  };
  const versionOf = (content: string, defaults: Record<string, string>, number: number) => {
    const text = content.trim();
    if (text === '') throw fakeError('validation_failed', 'A prompt needs a text');
    return { id: nextId(), number, content: text, variables: buildPromptVariables(text, defaults), createdAt: promptTime() };
  };
  const handlers: { [C in LibraryChannel]: NonNullable<FakeHandlers[C]> } = {
    'prompts:list': ({ query, tagNames = [], offset, limit }) => {
      const words = (query ?? '').toLowerCase().split(/\s+/).filter((word) => word !== '');
      const matching = state.prompts.filter((item) => {
        const text = `${item.title} ${item.description} ${item.currentVersion.content}`.toLowerCase();
        return words.every((word) => text.includes(word)) && tagNames.every((name) => item.tags.some((tag) => tag.name === name));
      });
      return { items: matching.slice(offset, offset + limit).map((item) => structuredClone(summaryOf(item))), total: matching.length };
    },
    'prompts:get': ({ promptId }) => structuredClone(find(promptId)),
    'prompts:create': ({ title, description, content, defaults }) => {
      checkTitle(title.trim(), null);
      const version = versionOf(content, defaults, 1);
      const created = promptDetail({ title: title.trim(), description: description.trim(), versions: [version], createdAt: version.createdAt });
      state.prompts = [created, ...state.prompts];
      return structuredClone(created);
    },
    'prompts:update': ({ promptId, title, description }) => {
      const current = find(promptId);
      checkTitle(title.trim(), promptId);
      return store({ ...current, title: title.trim(), description: description.trim(), updatedAt: promptTime() });
    },
    'prompts:saveVersion': ({ promptId, baseVersionId, content, defaults }) => {
      const current = find(promptId);
      if (current.currentVersion.id !== baseVersionId) throw fakeError('invalid_operation', 'This prompt was changed in the meantime');
      const version = versionOf(content, defaults, current.currentVersion.number + 1);
      return store({ ...current, currentVersion: version, versions: [version, ...current.versions], updatedAt: version.createdAt });
    },
    'prompts:delete': ({ promptId }) => {
      find(promptId);
      state.prompts = state.prompts.filter((item) => item.id !== promptId);
      return {};
    },
    'prompts:addTag': ({ promptId, name }) => {
      const current = find(promptId);
      const normalised = normalizeTagName(name);
      if (normalised === null) throw fakeError('validation_failed', 'invalid tag');
      if (current.tags.some((tag) => tag.name === normalised)) return structuredClone(current);
      return store({ ...current, tags: [...current.tags, { name: normalised, displayName: cleanTagText(name), origin: 'manual' }] });
    },
    'prompts:removeTag': ({ promptId, name }) => {
      const current = find(promptId);
      return store({ ...current, tags: current.tags.filter((tag) => tag.name !== name) });
    },
  };
  return { state, handlers };
}

type GenerationChannel =
  | 'generations:start'
  | 'generations:forFile'
  | 'generations:retry'
  | 'generations:remove'
  | 'generations:recentPrompts';

/**
 * The `generations:*` answers of a workspace without generations: no image provider to start with,
 * no generation to retry or remove, empty lists.
 */
export function fakeGenerationDefaults(): { [C in GenerationChannel]: NonNullable<FakeHandlers[C]> } {
  return {
    'generations:start': () => {
      throw fakeError('provider_not_configured', 'No provider is configured');
    },
    'generations:forFile': () => ({ madeBy: null, results: [] }),
    'generations:retry': () => {
      throw fakeError('not_found', 'This generation does not exist');
    },
    'generations:remove': () => {
      throw fakeError('not_found', 'This generation does not exist');
    },
    'generations:recentPrompts': () => ({ prompts: [] }),
  };
}

/** A `changes:since` answer without any change and without `reset`; `p` sets what changed. */
export function noChanges(p: Partial<Changes> = {}): Changes {
  return { cursor: 'fake-cursor', reset: false, jobIds: [], jobs: false, fileIds: [], added: [], ...p };
}

/**
 * Every handler not given falls back to an `internal_error`, except the `analysisPrompts:*` ones (see
 * `fakeAnalysisPrompts`), the `providers:*` ones with no entry (see `fakeProviders`), the
 * `generations:*` ones (see `fakeGenerationDefaults`), the origin channels of files without
 * origins (see `fakeFileOrigins`) and `changes:since`, which answers no change (see `noChanges`).
 */
export function installFakeApi(handlers: FakeHandlers): {
  calls: { channel: IpcChannel; request: unknown }[];
  set<C extends IpcChannel>(channel: C, handler: FakeHandlers[C]): void;
} {
  const table: Record<string, ((request: never) => unknown) | undefined> = {
    ...fakeAnalysisPrompts().handlers,
    ...fakeProviders().handlers,
    ...fakeGenerationDefaults(),
    ...fakeFileOrigins({}).handlers,
    'changes:since': () => noChanges(),
    ...handlers,
  };
  const calls: { channel: IpcChannel; request: unknown }[] = [];
  const api = {
    async invoke(channel: IpcChannel, request: unknown): Promise<IpcResult<never>> {
      calls.push({ channel, request });
      const handler = table[channel];
      if (!handler) return { ok: false, error: { code: 'internal_error', message: 'internal_error' } };
      try {
        return { ok: true, value: (await handler(request as never)) as never };
      } catch (error) {
        if (error instanceof FakeError) return { ok: false, error: { code: error.code, message: error.message } };
        throw error;
      }
    },
  };
  Object.defineProperty(window, 'assetForge', { value: api, configurable: true, writable: true });
  return {
    calls,
    set(channel, handler) {
      table[channel] = handler as ((request: never) => unknown) | undefined;
    },
  };
}
