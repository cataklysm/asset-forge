import { readFileSync } from 'node:fs';
import https from 'node:https';
import type { AddressInfo, Socket } from 'node:net';
import type { Readable } from 'node:stream';
import tls from 'node:tls';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RemoteFileError } from '@assetforge/core';
import { createUrlSource } from '../src/index.js';

// A TLS server on 127.0.0.1 with a self-signed certificate for `files.test` (test fixture only, valid until 2126).
// The URL names `files.test`; only the pinned lookup brings the socket to the server.
const KEY = readFileSync(new URL('./fixtures/tls-files-test.key.pem', import.meta.url));
const CERT = readFileSync(new URL('./fixtures/tls-files-test.cert.pem', import.meta.url), 'utf8');
const HOST = 'files.test';

let server: https.Server;
let sockets: Set<Socket>;
let serverNames: (string | false | null)[];
let hosts: (string | undefined)[];
let port: number;
let defaultCertificates: string[];

beforeAll(() => {
  defaultCertificates = tls.getCACertificates('default');
});

afterAll(() => {
  tls.setDefaultCACertificates(defaultCertificates);
});

beforeEach(async () => {
  sockets = new Set();
  serverNames = [];
  hosts = [];
  server = https.createServer({ key: KEY, cert: CERT }, (request, response) => {
    hosts.push(request.headers.host);
    response.end('secure body');
  });
  server.on('secureConnection', (socket) => serverNames.push(socket.servername));
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  tls.setDefaultCACertificates(defaultCertificates);
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/**
 * Opens `https://files.test:<port>/file.jpg` with a lookup that answers only the server's address.
 *
 * @returns the opened file
 */
function openPinned() {
  const source = createUrlSource({
    userAgent: 'AssetForge/0.0.0-test',
    allowAddress: () => true,
    lookup: async () => ['127.0.0.1'],
  });
  return source.open(`https://${HOST}:${port}/file.jpg`, new AbortController().signal);
}

/**
 * Reads a body to its end.
 *
 * @param stream the body
 * @returns its bytes
 */
async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

describe('createUrlSource over TLS', () => {
  it('connects to the pinned address while SNI, Host and the certificate check use the host name', async () => {
    tls.setDefaultCACertificates([CERT]);
    const file = await openPinned();
    expect((await collect(file.stream)).toString()).toBe('secure body');
    expect(serverNames).toEqual([HOST]);
    expect(hosts).toEqual([`${HOST}:${port}`]);
  });

  it('refuses a certificate that is not trusted', async () => {
    const error = await openPinned().then(
      () => null,
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(RemoteFileError);
    expect((error as RemoteFileError).failure).toBe('unreachable');
    expect(hosts).toEqual([]);
  });
});
