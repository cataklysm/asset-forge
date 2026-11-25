import type { ErrorCode, IpcChannel, IpcRequest, IpcResponse, IpcResult } from '@assetforge/contracts';

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

export function fakeError(code: ErrorCode, message = code): Error {
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

export function installFakeApi(handlers: FakeHandlers): {
  calls: { channel: IpcChannel; request: unknown }[];
  set<C extends IpcChannel>(channel: C, handler: FakeHandlers[C]): void;
} {
  const table: Record<string, ((request: never) => unknown) | undefined> = { ...handlers };
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
