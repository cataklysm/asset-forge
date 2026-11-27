import type { Readable } from 'node:stream';
import { RemoteFileError, type RemoteFileSource } from './ports.js';

/** The product token the crawl obeys before the `*` group. */
export const ROBOTS_PRODUCT_TOKEN = 'assetforge';
/** The most of a robots.txt that is read; the rest is ignored. */
export const ROBOTS_MAX_BYTES = 512 * 1024;

export interface RobotsRule {
  allow: boolean;
  /** The path pattern with percent escapes in upper case; `*` any run, a trailing `$` the end. */
  pattern: string;
}

export interface RobotsGroup {
  /** Lower-case user-agent values of the group. */
  agents: string[];
  rules: RobotsRule[];
}

export interface RobotsRules {
  groups: RobotsGroup[];
}

/** Percent-encodes what a URL path would encode and upper-cases every escape, so patterns and paths compare alike. */
function normalizePath(path: string): string {
  let encoded: string;
  try {
    encoded = encodeURI(path);
  } catch {
    encoded = path;
  }
  // encodeURI escapes `%` itself; undo that for escapes that were already there.
  encoded = encoded.replace(/%25([0-9a-fA-F]{2})/g, '%$1');
  return encoded.replace(/%[0-9a-fA-F]{2}/g, (escape) => escape.toUpperCase());
}

/** Parses a robots.txt (RFC 9309). Never throws; lines it does not understand are skipped. */
export function parseRobots(text: string): RobotsRules {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  // True while consecutive user-agent lines still add to the same group.
  let collectingAgents = false;

  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const hash = rawLine.indexOf('#');
    const line = (hash === -1 ? rawLine : rawLine.slice(0, hash)).trim();
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (key === 'user-agent') {
      if (!collectingAgents || current === null) {
        current = { agents: [], rules: [] };
        groups.push(current);
        collectingAgents = true;
      }
      if (value !== '') current.agents.push(value.toLowerCase());
      continue;
    }
    if (key === 'allow' || key === 'disallow') {
      collectingAgents = false;
      if (current === null) continue;
      // An empty path matches nothing (an empty Disallow allows everything).
      if (value === '') continue;
      current.rules.push({ allow: key === 'allow', pattern: normalizePath(value) });
      continue;
    }
    // Other keys (Sitemap, Crawl-delay, ...) end the user-agent run but carry no rule.
    collectingAgents = false;
  }
  return { groups };
}

/** True when a group's user-agent value names the product token (`AssetForge`, `AssetForge/1.0`, ...). */
function namesProduct(agent: string): boolean {
  const token = agent.split(/[\s/]/, 1)[0] ?? '';
  return token === ROBOTS_PRODUCT_TOKEN;
}

/**
 * Whether `path` matches `pattern` from its start. Linear in time per star (greedy matching with one backtrack
 * point), so a pattern full of wildcards cannot stall the crawl.
 */
function matches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  let p = 0;
  let s = 0;
  let star = -1;
  let starS = 0;
  while (s < path.length) {
    if (p < body.length && body[p] !== '*' && body[p] === path[s]) {
      p++;
      s++;
    } else if (p < body.length && body[p] === '*') {
      star = p++;
      starS = s;
    } else if (p === body.length && !anchored) {
      // The whole pattern matched a prefix.
      return true;
    } else if (star !== -1) {
      p = star + 1;
      s = ++starS;
    } else {
      return false;
    }
  }
  while (p < body.length && body[p] === '*') p++;
  return p === body.length;
}

/**
 * Whether the rules allow `url`: the group for `AssetForge` (case-insensitive), else the `*` group, else everything
 * is allowed. Within the group the longest matching pattern wins and Allow wins a tie. A URL that cannot be parsed
 * is refused.
 */
export function robotsAllows(rules: RobotsRules, url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const path = normalizePath(`${parsed.pathname}${parsed.search}`);

  let chosen = rules.groups.filter((group) => group.agents.some(namesProduct));
  if (chosen.length === 0) chosen = rules.groups.filter((group) => group.agents.includes('*'));

  let best: RobotsRule | null = null;
  for (const group of chosen) {
    for (const rule of group.rules) {
      if (!matches(rule.pattern, path)) continue;
      if (
        best === null ||
        rule.pattern.length > best.pattern.length ||
        (rule.pattern.length === best.pattern.length && rule.allow)
      ) {
        best = rule;
      }
    }
  }
  return best === null || best.allow;
}

export type RobotsAnswer = { kind: 'rules'; rules: RobotsRules } | { kind: 'none' } | { kind: 'unavailable' };

/** Reads at most `limit` bytes of `stream` and destroys it once it stops reading, for any reason. */
function readCapped(stream: Readable, limit: number, signal: AbortSignal): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (error: unknown, value?: Buffer) => {
      if (done) return;
      done = true;
      signal.removeEventListener('abort', onAbort);
      stream.off('data', onData);
      stream.off('end', onEnd);
      // A stream destroyed later may still emit an error; keep a listener so it never goes unhandled.
      stream.on('error', () => {});
      stream.off('error', onError);
      stream.destroy();
      if (error !== undefined) reject(error);
      else resolve(value!);
    };
    const onError = (error: unknown) => finish(error ?? new Error('stream failed'));
    const onAbort = () => finish(signal.reason);
    const onEnd = () => finish(undefined, Buffer.concat(chunks, size));
    const onData = (chunk: Buffer | string) => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      const room = limit - size;
      if (buffer.length >= room) {
        chunks.push(buffer.subarray(0, room));
        size += room;
        finish(undefined, Buffer.concat(chunks, size));
        return;
      }
      chunks.push(buffer);
      size += buffer.length;
    };
    stream.on('error', onError);
    if (stream.destroyed) {
      // Already gone: no `end` will come, and any error was emitted before this listener.
      finish(stream.errored ?? new Error('stream destroyed'));
      return;
    }
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    stream.on('end', onEnd);
    stream.on('data', onData);
  });
}

/**
 * Reads `<origin>/robots.txt` through `remote` without options (no cookies, the downloader's own user agent),
 * at most ROBOTS_MAX_BYTES; 404/410 answer `none`, any other failure `unavailable`. Rejects only with the abort
 * reason once `signal` aborts. Nothing it answers carries the URL.
 */
export function createRobotsReader(
  remote: RemoteFileSource,
): (origin: string, signal: AbortSignal) => Promise<RobotsAnswer> {
  return async (origin, signal) => {
    let stream: Readable;
    try {
      const file = await remote.open(`${origin}/robots.txt`, signal);
      stream = file.stream;
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof RemoteFileError && error.failure === 'not_found') return { kind: 'none' };
      return { kind: 'unavailable' };
    }
    let body: Buffer;
    try {
      body = await readCapped(stream, ROBOTS_MAX_BYTES, signal);
    } catch {
      if (signal.aborted) throw signal.reason;
      return { kind: 'unavailable' };
    }
    let text = body.toString('utf8');
    if (text.startsWith('﻿')) text = text.slice(1);
    return { kind: 'rules', rules: parseRobots(text) };
  };
}
