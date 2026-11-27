import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { MEDIA_SCHEME, MEDIA_SCHEME_PRIVILEGES } from '../src/main/media-protocol.js';

describe('renderer content security policy', () => {
  it('is pinned as a whole', async () => {
    const html = await readFile(new URL('../src/renderer/index.html', import.meta.url), 'utf8');
    const policies = [...html.matchAll(/http-equiv="Content-Security-Policy"\s+content="([^"]*)"/g)].map((m) => m[1]);
    expect(policies).toEqual([
      `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' ${MEDIA_SCHEME}:; media-src ${MEDIA_SCHEME}:`,
    ]);
  });
});

describe('media scheme privileges', () => {
  it('are standard, secure and streaming, nothing else', () => {
    expect(MEDIA_SCHEME_PRIVILEGES).toEqual({ standard: true, secure: true, stream: true });
  });
});
