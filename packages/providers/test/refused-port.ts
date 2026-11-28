import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** The servers holding the ports of `refusedUrl`, closed by `releaseRefusedPorts`. */
const holders: Server[] = [];

/** Whether the whole 127.0.0.0/8 block is loopback here; macOS configures only 127.0.0.1 by default. */
const HAS_SECOND_LOOPBACK = process.platform === 'win32' || process.platform === 'linux';

/**
 * A loopback URL that never gets an answer, for the whole test. A server holds a port on 127.0.0.1, so a parallel
 * test that asks for a free port is never given it, and the URL points at the same port on 127.0.0.2, where nothing
 * listens and the connection is refused. Where 127.0.0.2 is no loopback address the URL points at the holder itself,
 * which drops every connection at once. A port that is only opened and closed again could be taken by a parallel test.
 *
 * @param path appended to the origin, e.g. `/api/v1`
 * @returns the URL
 */
export async function refusedUrl(path = ''): Promise<string> {
  const server = createServer((_request, response) => response.end());
  if (!HAS_SECOND_LOOPBACK) server.on('connection', (socket) => socket.destroy());
  holders.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const host = HAS_SECOND_LOOPBACK ? '127.0.0.2' : '127.0.0.1';
  return `http://${host}:${(server.address() as AddressInfo).port}${path}`;
}

/**
 * Closes the servers of every `refusedUrl` so far.
 *
 * @returns resolves once they are closed
 */
export async function releaseRefusedPorts(): Promise<void> {
  await Promise.all(holders.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
}
