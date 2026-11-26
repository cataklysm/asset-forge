import { describe, expect, test } from 'vitest';
import { ORIGINAL_MAX_EDGE, ORIGINAL_MIME_TYPES, viewSource } from '../src/index';

describe('viewSource', () => {
  test('the edge limit', () => {
    expect(ORIGINAL_MAX_EDGE).toBe(8192);
  });

  test.each(ORIGINAL_MIME_TYPES.map((t) => [t]))('%s within the limit is original', (type) => {
    expect(viewSource(type, 7680, 4320)).toBe('original');
  });

  test.each([
    ['image/png', 8192, 8192, 'original'],
    ['image/png', 8193, 10, 'reduced'],
    ['image/jpeg', 10, 8193, 'reduced'],
    ['image/tiff', 8192, 100, 'converted'],
    ['image/tiff', 9000, 100, 'reduced'],
    ['image/png', null, null, 'preview'],
    ['image/tiff', null, null, 'preview'],
    ['image/png', 100, null, 'preview'],
    ['image/svg+xml', 100, 100, 'none'],
    ['text/html', 100, 100, 'none'],
    ['application/octet-stream', 100, 100, 'none'],
    ['IMAGE/PNG', 100, 100, 'none'],
    ['image/png; charset=x', 100, 100, 'none'],
    ['', 100, 100, 'none'],
  ] as const)('%s %s x %s is %s', (type, w, h, expected) => {
    expect(viewSource(type, w, h)).toBe(expected);
  });
});
