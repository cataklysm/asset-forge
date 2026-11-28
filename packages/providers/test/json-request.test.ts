import { describe, expect, it } from 'vitest';
import { JobError } from '@assetforge/core';
import { createJsonRequester, statusOf } from '../src/index.js';

function answering(status: number, body: string): typeof fetch {
  return async () => new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

const request = (fetchImpl: typeof fetch) =>
  createJsonRequester({ baseUrl: 'http://127.0.0.1:1/', fetch: fetchImpl })(
    { path: '/x', body: {}, signal: new AbortController().signal, timeoutMs: 5_000 },
    (body) => body,
  );

describe('statusOf', () => {
  it('carries the HTTP status of a failed answer without putting it into the message', async () => {
    const error = await failureOf(request(answering(400, '{}')));
    expect(error).toBeInstanceOf(JobError);
    expect((error as JobError).code).toBe('provider_rejected');
    expect(statusOf(error)).toBe(400);
    expect((error as JobError).message).not.toContain('400');
    expect((error as JobError).cause).toBeUndefined();
  });

  it('is null for a request that never got an answer and for foreign errors', async () => {
    const error = await failureOf(
      request(async () => {
        throw new TypeError('refused');
      }),
    );
    expect((error as JobError).code).toBe('provider_unreachable');
    expect(statusOf(error)).toBeNull();
    expect(statusOf(new Error('x'))).toBeNull();
    expect(statusOf(new JobError('provider_rejected'))).toBeNull();
  });
});

describe('the timeout', () => {
  /** Answers at once with headers, then ends the body only after `delayMs`, ignoring every signal. */
  function slowBody(status: number, body: string, delayMs: number): typeof fetch {
    return async () => {
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          controller.enqueue(new TextEncoder().encode(body));
          controller.close();
        },
      });
      return new Response(stream, { status, headers: { 'content-type': 'application/json' } });
    };
  }

  const timed = (fetchImpl: typeof fetch, reports: string[]) =>
    createJsonRequester({ baseUrl: 'http://127.0.0.1:1/', fetch: fetchImpl, onFailure: (code) => reports.push(code) })(
      { path: '/x', signal: new AbortController().signal, timeoutMs: 10 },
      (body) => body,
    );

  it('keeps the code of an answer that arrived although the timer fired since', async () => {
    const reports: string[] = [];
    const error = await failureOf(timed(slowBody(200, 'not json', 60), reports));
    expect((error as JobError).code).toBe('invalid_response');
    expect(reports).toEqual(['invalid_response']);
  });

  it('still maps a request cut off by the timer to provider_timeout', async () => {
    const reports: string[] = [];
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error), { once: true }),
      );
    const error = await failureOf(timed(hanging, reports));
    expect((error as JobError).code).toBe('provider_timeout');
    expect(reports).toEqual(['provider_timeout']);
  });
});
