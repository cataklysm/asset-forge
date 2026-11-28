import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** The servers holding the ports of `refusedUrl`, closed by `releaseRefusedPorts`. */
const holders: Server[] = [];

/**
 * A loopback URL whose connection is refused, and stays refused for the whole test: a server holds the port on
 * 127.0.0.1, so no other test can listen on it (not even on all addresses), and the URL points at the same port on
 * 127.0.0.2, where nothing listens. A port that is only opened and closed again can be taken by a parallel test.
 *
 * @param path appended to the origin, e.g. `/api/v1`
 * @returns the URL
 */
export async function refusedUrl(path = ''): Promise<string> {
  const server = createServer((_request, response) => response.end());
  holders.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.2:${(server.address() as AddressInfo).port}${path}`;
}

/**
 * Closes the servers of every `refusedUrl` so far.
 *
 * @returns resolves once they are closed
 */
export async function releaseRefusedPorts(): Promise<void> {
  await Promise.all(holders.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
}
