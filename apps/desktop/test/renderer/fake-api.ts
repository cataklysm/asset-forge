import type {
  AnalysisPrompt,
  AnalysisPromptList,
  ErrorCode,
  IpcChannel,
  IpcRequest,
  IpcResponse,
  IpcResult,
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

/** Every handler not given falls back to an `internal_error`, except the `analysisPrompts:*` ones (see `fakeAnalysisPrompts`). */
export function installFakeApi(handlers: FakeHandlers): {
  calls: { channel: IpcChannel; request: unknown }[];
  set<C extends IpcChannel>(channel: C, handler: FakeHandlers[C]): void;
} {
  const table: Record<string, ((request: never) => unknown) | undefined> = {
    ...fakeAnalysisPrompts().handlers,
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
