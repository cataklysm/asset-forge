import { describe, expect, it } from 'vitest';
import { clampOffset } from '../src/renderer/src/paging.js';

describe('clampOffset', () => {
  it.each([
    [0, 0, 50, 0],
    [50, 0, 50, 50],
    [0, 10, 50, 0],
    [50, 51, 50, 50],
    [50, 50, 50, 0],
    [100, 50, 50, 0],
    [150, 120, 50, 100],
    [100, 101, 50, 100],
  ])('offset %i, total %i, limit %i -> %i', (offset, total, limit, expected) => {
    expect(clampOffset(offset, total, limit)).toBe(expected);
  });
});
