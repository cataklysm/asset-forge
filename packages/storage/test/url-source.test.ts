import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { Readable } from 'node:stream';
import { RemoteFileError, type RemoteFileSource } from '@assetforge/core';
import { createUrlSource, isPublicAddress, type UrlSourceOptions } from '../src/index.js';

const UA = 'AssetForge/0.0.0-test';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

let server: http.Server;
let sockets: Set<Socket>;
let handler: Handler;
let requests: http.IncomingMessage[];
let base: string;
let port: number;

beforeEach(async () => {
  requests = [];
  sockets = new Set();
  handler = (_req, res) => res.end('ok');
  server = http.createServer((req, res) => {
    requests.push(req);
    handler(req, res);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function source(options: Partial<UrlSourceOptions> = {}): RemoteFileSource {
  return createUrlSource({ userAgent: UA, allowAddress: () => true, ...options });
}

function open(url: string, options: Partial<UrlSourceOptions> = {}, signal = new AbortController().signal) {
  return source(options).open(url, signal);
}

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function failureOf(promise: Promise<unknown>): Promise<RemoteFileError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RemoteFileError);
    return error as RemoteFileError;
  }
  throw new Error('expected a failure');
}

describe('createUrlSource: the file', () => {
  it('streams a 200 answer with type, length and disposition name', async () => {
    handler = (_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'Image/PNG; charset=binary',
        'Content-Length': '5',
        'Content-Disposition': 'attachment; filename="plain.png"; filename*=UTF-8\'\'na%C3%AFve%20one.png',
      });
      res.end('hello');
    };
    const file = await open(`${base}/a/b.png?x=1`);
    expect(file.contentType).toBe('image/png');
    expect(file.contentLength).toBe(5);
    expect(file.dispositionName).toBe('naïve one.png');
    expect(file.finalUrl).toBe(`${base}/a/b.png?x=1`);
    expect((await collect(file.stream)).toString()).toBe('hello');
  });

  it.each([
    ['attachment; filename="quoted \\"name\\".jpg"', 'quoted "name".jpg'],
    ['attachment; filename=token.jpg', 'token.jpg'],
    ['inline', null],
    ['attachment; filename*=UTF-8\'\'%E0%A4%A', null],
  ])('reads the disposition name of %s', async (header, expected) => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Disposition': header });
      res.end('x');
    };
    const file = await open(`${base}/f`);
    expect(file.dispositionName).toBe(expected);
    expect(file.contentType).toBeNull();
    await collect(file.stream);
  });

  it('sends exactly User-Agent, Accept and Accept-Encoding besides Host and Connection', async () => {
    const file = await open(`${base}/h`);
    await collect(file.stream);
    const req = requests[0]!;
    expect(req.method).toBe('GET');
    const names = new Set<string>();
    for (let i = 0; i < req.rawHeaders.length; i += 2) names.add(req.rawHeaders[i]!.toLowerCase());
    expect([...names].sort()).toEqual(['accept', 'accept-encoding', 'connection', 'host', 'user-agent']);
    expect(req.headers['user-agent']).toBe(UA);
    expect(req.headers.accept).toBe('*/*');
    expect(req.headers['accept-encoding']).toBe('identity');
    expect(req.headers.host).toBe(`127.0.0.1:${port}`);
  });

  it('connects to the checked address while the Host header keeps the host name', async () => {
    const seen: string[] = [];
    const file = await open(`http://files.example.test:${port}/n`, {
      lookup: async (host) => {
        seen.push(host);
        return ['127.0.0.1'];
      },
    });
    await collect(file.stream);
    expect(seen).toEqual(['files.example.test']);
    expect(requests[0]!.headers.host).toBe(`files.example.test:${port}`);
  });
});

describe('createUrlSource: redirects', () => {
  beforeEach(() => {
    handler = (req, res) => {
      const m = /^\/r\/(\d+)$/.exec(req.url ?? '');
      if (m && m[1] !== '0') {
        res.writeHead(302, { Location: `/r/${Number(m[1]) - 1}` });
        res.end('moved');
        return;
      }
      res.end('done');
    };
  });

  it('follows a chain of five', async () => {
    const file = await open(`${base}/r/5`);
    expect(file.finalUrl).toBe(`${base}/r/0`);
    expect((await collect(file.stream)).toString()).toBe('done');
  });

  it('refuses a sixth redirect', async () => {
    expect((await failureOf(open(`${base}/r/6`))).failure).toBe('rejected');
  });

  it.each([301, 303, 307, 308])('follows %i', async (status) => {
    handler = (req, res) => {
      if (req.url === '/start') {
        res.writeHead(status, { Location: `${base}/end` });
        res.end();
      } else res.end('end');
    };
    expect((await collect((await open(`${base}/start`)).stream)).toString()).toBe('end');
  });

  it.each([
    ['another scheme', 'ftp://example.com/x'],
    ['user info', `http://user:pw@127.0.0.1:${port}/x`],
    ['an unparsable location', 'http://[bad'],
    ['no location', null],
  ])('refuses a redirect with %s', async (_case, location) => {
    handler = (_req, res) => {
      res.writeHead(302, location === null ? {} : { Location: location });
      res.end();
    };
    expect((await failureOf(open(`${base}/x`))).failure).toBe('rejected');
  });

  it('refuses a scheme other than http and https at the start', async () => {
    expect((await failureOf(open('ftp://example.com/x'))).failure).toBe('rejected');
    expect((await failureOf(open('file:///etc/passwd'))).failure).toBe('rejected');
  });
});

describe('createUrlSource: status mapping', () => {
  it.each([
    [204, 'rejected'],
    [206, 'rejected'],
    [300, 'rejected'],
    [304, 'rejected'],
    [400, 'rejected'],
    [418, 'rejected'],
    [401, 'blocked'],
    [403, 'blocked'],
    [407, 'blocked'],
    [451, 'blocked'],
    [404, 'not_found'],
    [410, 'not_found'],
    [408, 'unavailable'],
    [500, 'unavailable'],
    [502, 'unavailable'],
    [504, 'unavailable'],
    [429, 'throttled'],
    [503, 'throttled'],
  ])('maps %i to %s', async (status, failure) => {
    handler = (_req, res) => {
      res.writeHead(status);
      res.end(status === 204 || status === 304 ? undefined : 'body');
    };
    const error = await failureOf(open(`${base}/s`));
    expect(error.failure).toBe(failure);
    expect(error.retryAfterMs).toBe(failure === 'throttled' ? 60_000 : null);
    expect(error.message).not.toContain('127.0.0.1');
  });

  it.each([
    ['120', 120_000],
    ['1', 5_000],
    ['99999', 900_000],
    ['soon', 60_000],
    ['2026', 900_000],
    ['tomorrow', 60_000],
    ['2026-11-27', 60_000],
    ['Sunday, 06-Nov-94 08:49:37 GMT', 60_000],
  ])('reads Retry-After %s', async (value, ms) => {
    handler = (_req, res) => {
      res.writeHead(429, { 'Retry-After': value });
      res.end();
    };
    expect((await failureOf(open(`${base}/t`))).retryAfterMs).toBe(ms);
  });

  it('reads Retry-After as an HTTP date', async () => {
    handler = (_req, res) => {
      res.writeHead(503, { 'Retry-After': new Date(Date.now() + 120_000).toUTCString() });
      res.end();
    };
    const ms = (await failureOf(open(`${base}/t`))).retryAfterMs!;
    expect(ms).toBeGreaterThan(115_000);
    expect(ms).toBeLessThanOrEqual(120_000);
  });

  it('refuses a content encoding', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Encoding': 'gzip' });
      res.end('xx');
    };
    expect((await failureOf(open(`${base}/g`))).failure).toBe('rejected');
  });

  it('accepts the identity content encoding', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Encoding': 'identity' });
      res.end('xx');
    };
    expect((await collect((await open(`${base}/g`)).stream)).toString()).toBe('xx');
  });
});

describe('createUrlSource: limits', () => {
  it('refuses a Content-Length over the limit before any body byte', async () => {
    let wrote = false;
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Length': '1000' });
      res.flushHeaders();
      setTimeout(() => {
        wrote = true;
        res.end('x'.repeat(1000));
      }, 200).unref();
    };
    expect((await failureOf(open(`${base}/big`, { maxBytes: 10 }))).failure).toBe('too_large');
    expect(wrote).toBe(false);
  });

  it('fails the stream past the limit when the body is chunked', async () => {
    handler = (_req, res) => {
      res.writeHead(200);
      res.write('x'.repeat(10));
      res.write('x'.repeat(10));
      res.end('x'.repeat(10));
    };
    const file = await open(`${base}/chunked`, { maxBytes: 15 });
    expect(file.contentLength).toBeNull();
    expect((await failureOf(collect(file.stream))).failure).toBe('too_large');
  });

  it('accepts a body of exactly the limit', async () => {
    handler = (_req, res) => res.end('x'.repeat(15));
    expect((await collect((await open(`${base}/exact`, { maxBytes: 15 })).stream)).length).toBe(15);
  });

  it('fails the stream when the body stalls', async () => {
    handler = (_req, res) => {
      res.writeHead(200);
      res.write('abc');
    };
    const file = await open(`${base}/stall`, { idleTimeoutMs: 50 });
    expect((await failureOf(collect(file.stream))).failure).toBe('unreachable');
  });

  it('fails the stream past the total time', async () => {
    handler = (_req, res) => {
      res.writeHead(200);
      const timer = setInterval(() => res.write('a'), 10);
      res.on('close', () => clearInterval(timer));
    };
    const file = await open(`${base}/trickle`, { idleTimeoutMs: 1000, totalTimeoutMs: 120 });
    expect((await failureOf(collect(file.stream))).failure).toBe('unreachable');
  });

  it('fails the stream when the body is shorter than Content-Length', async () => {
    handler = (req, res) => {
      res.writeHead(200, { 'Content-Length': '100' });
      res.write('x'.repeat(10), () => setTimeout(() => req.socket.destroy(), 10));
    };
    const file = await open(`${base}/short`);
    expect((await failureOf(collect(file.stream))).failure).toBe('unreachable');
  });

  it('rejects when the headers do not come in time', async () => {
    handler = () => {};
    expect((await failureOf(open(`${base}/silent`, { headerTimeoutMs: 50 }))).failure).toBe('unreachable');
  });

  it('rejects when the connection is refused', async () => {
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const freePort = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    expect((await failureOf(open(`http://127.0.0.1:${freePort}/`))).failure).toBe('unreachable');
  });

  it('rejects when the name does not resolve', async () => {
    const failing = async (): Promise<string[]> => {
      throw new Error('ENOTFOUND');
    };
    expect((await failureOf(open('http://nowhere.test/', { lookup: failing }))).failure).toBe('unreachable');
    expect((await failureOf(open('http://nowhere.test/', { lookup: async () => [] }))).failure).toBe('unreachable');
  });
});

describe('createUrlSource: abort', () => {
  it('errors the stream with the abort reason mid-body', async () => {
    handler = (_req, res) => {
      res.writeHead(200);
      res.write('first');
    };
    const controller = new AbortController();
    const file = await open(`${base}/abort`, {}, controller.signal);
    const reason = new Error('stop');
    let error: unknown = null;
    let chunks = 0;
    try {
      for await (const _chunk of file.stream) {
        chunks++;
        controller.abort(reason);
      }
    } catch (e) {
      error = e;
    }
    expect(chunks).toBe(1);
    expect(error).toBe(reason);
  });

  it('rejects open with the abort reason while waiting for the headers', async () => {
    handler = () => {};
    const controller = new AbortController();
    const reason = new Error('stop');
    const opening = open(`${base}/abort`, {}, controller.signal);
    setTimeout(() => controller.abort(reason), 20);
    await expect(opening).rejects.toBe(reason);
  });

  it('rejects promptly with the abort reason when the abort falls between two hops, and sends no second request', async () => {
    handler = (req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { Location: `${base}/second` });
        res.end();
      }
      // The second hop never answers: only its header timeout would end a request to it.
    };
    const controller = new AbortController();
    const reason = new Error('stop');
    let checks = 0;
    // The address check of the second hop runs after the first hop settled and before the second is sent,
    // outside every abort listener.
    const allowAddress = () => {
      checks++;
      if (checks === 2) controller.abort(reason);
      return true;
    };
    const started = Date.now();
    await expect(open(`${base}/start`, { allowAddress, headerTimeoutMs: 3_000 }, controller.signal)).rejects.toBe(reason);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(requests.map((r) => r.url)).toEqual(['/start']);
  });

  it('rejects with the abort reason when the abort comes while the first hop prepares its redirect', async () => {
    const controller = new AbortController();
    const reason = new Error('stop');
    handler = (req, res) => {
      if (req.url === '/start') {
        controller.abort(reason);
        res.writeHead(302, { Location: `${base}/second` });
        res.end();
      }
    };
    const started = Date.now();
    await expect(open(`${base}/start`, { headerTimeoutMs: 3_000 }, controller.signal)).rejects.toBe(reason);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(requests.map((r) => r.url)).toEqual(['/start']);
  });

  it('rejects at once for an aborted signal', async () => {
    const controller = new AbortController();
    const reason = new Error('stop');
    controller.abort(reason);
    await expect(open(`${base}/x`, {}, controller.signal)).rejects.toBe(reason);
    expect(requests).toHaveLength(0);
  });
});

describe('createUrlSource: the default address policy', () => {
  function strict(options: Partial<UrlSourceOptions> = {}): RemoteFileSource {
    return createUrlSource({ userAgent: UA, ...options });
  }

  it('refuses a loopback literal without sending a request', async () => {
    const error = await failureOf(strict().open(`${base}/`, new AbortController().signal));
    expect(error.failure).toBe('address_refused');
    expect(requests).toHaveLength(0);
  });

  it.each([
    ['the IPv6 loopback', (p: number) => `http://[::1]:${p}/`],
    ['an IPv4-mapped loopback', (p: number) => `http://[::ffff:127.0.0.1]:${p}/`],
  ])('refuses %s literal without sending a request', async (_name, url) => {
    const error = await failureOf(strict().open(url(port), new AbortController().signal));
    expect(error.failure).toBe('address_refused');
    expect(requests).toHaveLength(0);
  });

  it('refuses a host when any of its addresses is not public', async () => {
    const lookup = async () => ['93.184.216.34', '10.0.0.5'];
    const error = await failureOf(strict({ lookup }).open('http://mixed.example.test/', new AbortController().signal));
    expect(error.failure).toBe('address_refused');
  });

  it('refuses a redirect to a loopback address', async () => {
    handler = (req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { Location: `http://127.0.0.1:${port}/x` });
        res.end();
      } else res.end('secret');
    };
    let first = true;
    const allowAddress = (address: string) => {
      if (first) {
        first = false;
        return true;
      }
      return isPublicAddress(address);
    };
    const source = strict({ lookup: async () => ['127.0.0.1'], allowAddress });
    const error = await failureOf(source.open(`http://public.example.test:${port}/start`, new AbortController().signal));
    expect(error.failure).toBe('address_refused');
    expect(requests.map((r) => r.url)).toEqual(['/start']);
  });
});

describe('createUrlSource: headers of a site login', () => {
  const lookup = async () => ['127.0.0.1'];
  const headerNames = (req: http.IncomingMessage) => {
    const names = new Set<string>();
    for (let i = 0; i < req.rawHeaders.length; i += 2) names.add(req.rawHeaders[i]!.toLowerCase());
    return [...names].sort();
  };

  it('asks once per hop with that hop URL and sends a cookie only where it answers one', async () => {
    handler = (req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { Location: `http://other.example.test:${port}/away` });
        res.end();
      } else if (req.url === '/away') {
        res.writeHead(302, { Location: `http://site.example.test:${port}/back` });
        res.end();
      } else {
        res.end('file');
      }
    };
    const asked: string[] = [];
    const file = await source({ lookup }).open(`http://site.example.test:${port}/start`, new AbortController().signal, {
      headersFor: async (url) => {
        asked.push(url);
        return new URL(url).hostname === 'site.example.test' ? { cookie: 'sid=1', userAgent: 'Session/1.0' } : null;
      },
    });
    expect((await collect(file.stream)).toString()).toBe('file');
    expect(asked).toEqual([
      `http://site.example.test:${port}/start`,
      `http://other.example.test:${port}/away`,
      `http://site.example.test:${port}/back`,
    ]);
    expect(requests.map((r) => [r.url, r.headers.cookie, r.headers['user-agent']])).toEqual([
      ['/start', 'sid=1', 'Session/1.0'],
      ['/away', undefined, UA],
      ['/back', 'sid=1', 'Session/1.0'],
    ]);
  });

  it('a hop answering cookie and agent sends exactly those two besides the fixed headers', async () => {
    const file = await source().open(`${base}/h`, new AbortController().signal, {
      headersFor: async () => ({ cookie: 'a=1; b=2', userAgent: 'Session/1.0' }),
    });
    await collect(file.stream);
    const req = requests[0]!;
    expect(headerNames(req)).toEqual(['accept', 'accept-encoding', 'connection', 'cookie', 'host', 'user-agent']);
    expect(req.headers.cookie).toBe('a=1; b=2');
    expect(req.headers['user-agent']).toBe('Session/1.0');
  });

  it('a hop answering null sends no cookie and the configured agent', async () => {
    const file = await source().open(`${base}/h`, new AbortController().signal, { headersFor: async () => null });
    await collect(file.stream);
    expect(headerNames(requests[0]!)).toEqual(['accept', 'accept-encoding', 'connection', 'host', 'user-agent']);
    expect(requests[0]!.headers['user-agent']).toBe(UA);
  });

  it.each([
    ['a cookie with a line break', { cookie: 'a=1\r\nX-Evil: 1', userAgent: 'Session/1.0' }, undefined, 'Session/1.0'],
    ['a cookie with a tab', { cookie: 'a=1\tb', userAgent: 'Session/1.0' }, undefined, 'Session/1.0'],
    ['an agent with a NUL', { cookie: 'a=1', userAgent: 'Session\u0000' }, 'a=1', UA],
    ['an agent with DEL', { cookie: 'a=1', userAgent: 'Session\u007f' }, 'a=1', UA],
    ['an agent Node cannot send', { cookie: 'a=1', userAgent: 'Session ' }, 'a=1', UA],
  ])('drops %s', async (_name, answer, cookie, agent) => {
    const file = await source().open(`${base}/h`, new AbortController().signal, { headersFor: async () => answer });
    await collect(file.stream);
    const req = requests[0]!;
    expect(req.headers.cookie).toBe(cookie);
    expect(req.headers['user-agent']).toBe(agent);
    expect(req.headers['x-evil']).toBeUndefined();
  });

  it('a rejecting headersFor fails the open as unreachable without a cause and sends nothing', async () => {
    const error = await failureOf(
      source().open(`${base}/h`, new AbortController().signal, {
        headersFor: async () => {
          throw new Error(`secret ${base}/h`);
        },
      }),
    );
    expect(error.failure).toBe('unreachable');
    expect(error.cause).toBeUndefined();
    expect(error.message).not.toContain('secret');
    expect(requests).toEqual([]);
  });
});
