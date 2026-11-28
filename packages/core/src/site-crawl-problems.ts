import { SITE_PROBLEM_VALUE_MAX } from '@assetforge/contracts';

/** A host (with an optional port) the crawl answer may carry; '' when it is too long or looks odd. */
const SAFE_HOST = /^[a-z0-9.\-_[\]:]{1,253}$/;
export function safeHost(host: string): string {
  const lower = host.toLowerCase();
  return SAFE_HOST.test(lower) ? lower : '';
}

/** A page-controlled value for the answer: control and format characters removed, cut without splitting a pair. */
export function cutValue(text: string): string {
  const clean = text.replace(/[\p{Cc}\p{Cf}]/gu, '');
  let out = '';
  for (const ch of clean) {
    if (out.length + ch.length > SITE_PROBLEM_VALUE_MAX) break;
    out += ch;
  }
  return out;
}
