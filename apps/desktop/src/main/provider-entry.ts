import {
  DEFAULT_PROVIDER_OPTIONS,
  isVisionKind,
  type ProviderKind,
  type ProviderOptions,
  type ProviderPurpose,
} from '@assetforge/contracts';

// One provider entry as the store keeps it, the rules every entry obeys, and the refusals that name an entry.

/** The refusal for an id that names no entry. */
export const PROVIDER_NOT_FOUND = 'This provider does not exist';
/** The refusal for a save that sends another kind than the stored one. */
export const KIND_CHANGED = 'The kind of a provider cannot be changed';
/** The refusal for a vision entry used for an image generation. */
export const CANNOT_GENERATE = 'This provider cannot generate images';
/** The refusal for an image entry used for an analysis. */
export const CANNOT_ANALYSE = 'This provider cannot analyse images';

/**
 * The refusal for an entry used for the other purpose.
 *
 * @param wanted the purpose the caller asked for
 * @returns the message that names what the entry cannot do
 */
export const wrongKind = (wanted: ProviderPurpose): string => (wanted === 'image' ? CANNOT_GENERATE : CANNOT_ANALYSE);

/** One provider entry: a vision kind (`ollama`, `openai`) or the image kind (`venice`). */
export interface ProviderEntry {
  /** A UUID, or the fixed id of the environment entry. */
  id: string;
  /** Fixed when the entry is created. */
  kind: ProviderKind;
  /** 1 to 60 characters, unique regardless of case. */
  name: string;
  /** The base URL after the base URL rule, without trailing slashes. */
  baseUrl: string;
  /** The request timeout in seconds. */
  timeoutSeconds: number;
  /** Always null for `venice`. */
  taggingModel: string | null;
  /** Always null for `venice`. */
  promptModel: string | null;
  /** Always null for a vision kind. */
  editModel: string | null;
  /** The request options of a vision kind; always null for `venice`. */
  options: ProviderOptions | null;
}

/**
 * The options an entry of the kind starts with.
 *
 * @param kind the entry's kind
 * @returns a copy of the default options for a vision kind, null for `venice`
 */
export const optionsFor = (kind: ProviderKind): ProviderOptions | null =>
  isVisionKind(kind) ? { ...DEFAULT_PROVIDER_OPTIONS } : null;

/**
 * An image provider carries a key for a paid service: https, or plain http only to this machine.
 *
 * @param baseUrl the entry's base URL
 * @returns true when the URL may carry the key of an image provider
 */
export function secureForImages(baseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  // The WHATWG parser has already normalised IPv4 forms (e.g. `127.1`) and IPv6 literals (e.g. `[0::1]`).
  const host = url.hostname;
  return host === 'localhost' || host === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * The origin of a base URL.
 *
 * @param baseUrl the URL to read
 * @returns its origin, null when it does not parse
 */
export function originOf(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return null;
  }
}

/**
 * Whether two URLs or origins name the same origin for keeping a stored key: `host.` and `host` are one DNS name, so
 * a single trailing dot of the host is ignored. Which origin a key is sent to is still decided by `originOf` alone.
 *
 * @param first a URL or an origin
 * @param second a URL or an origin
 * @returns true when both parse and their origins match apart from a trailing dot of the host
 */
export function isSameKeyOrigin(first: string, second: string): boolean {
  const firstOrigin = keyOriginOf(first);
  return firstOrigin !== null && firstOrigin === keyOriginOf(second);
}

/**
 * The origin of a URL with one trailing dot of the host removed.
 *
 * @param url a URL or an origin
 * @returns the origin without the dot, null when it does not parse
 */
function keyOriginOf(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.origin === 'null') return null;
  if (parsed.hostname.length > 1 && parsed.hostname.endsWith('.')) parsed.hostname = parsed.hostname.slice(0, -1);
  return parsed.origin;
}
