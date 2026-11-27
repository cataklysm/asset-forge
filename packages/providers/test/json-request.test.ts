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
