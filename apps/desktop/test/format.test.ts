import { describe, expect, it } from 'vitest';
import { formatBytes } from '../src/renderer/src/format.js';

describe('formatBytes', () => {
  it.each([
    [null, '–'],
    [0, '0 B'],
    [1023, '1023 B'],
    [1024, '1.0 KiB'],
    [1572864, '1.5 MiB'],
  ])('formats %s as %s', (input, expected) => {
    expect(formatBytes(input)).toBe(expected);
  });
});
