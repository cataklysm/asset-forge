import { SITE_PROBLEM_VALUE_MAX } from '@assetforge/contracts';

/** A host (with an optional port) the crawl answer may carry. */
const SAFE_HOST = /^[a-z0-9.\-_[\]:]{1,253}$/;

/**
 * A host for the crawl answer, in lower case.
 *
 * @param host the host, possibly with a port
 * @returns the host; '' when it is too long or looks odd
 */
export function safeHost(host: string): string {
  const lower = host.toLowerCase();
  return SAFE_HOST.test(lower) ? lower : '';
}

/**
 * A page-controlled value for the answer: control and format characters removed, cut without splitting a pair.
 *
 * @param text the value as the page gave it
 * @returns the cleaned value of at most SITE_PROBLEM_VALUE_MAX code units
 */
export function cutValue(text: string): string {
  const clean = text.replace(/[\p{Cc}\p{Cf}]/gu, '');
  let out = '';
  for (const character of clean) {
    if (out.length + character.length > SITE_PROBLEM_VALUE_MAX) break;
    out += character;
  }
  return out;
}
