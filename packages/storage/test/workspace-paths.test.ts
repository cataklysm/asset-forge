import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isInside } from '../src/workspace-paths.js';

describe('isInside', () => {
  const root = path.resolve('Work', 'Root');

  it('accepts the root and a path below it, and refuses a sibling with the same prefix', () => {
    expect(isInside(root, root)).toBe(true);
    expect(isInside(root, path.join(root, 'inbox', 'a.txt'))).toBe(true);
    expect(isInside(root, `${root}x`)).toBe(false);
    expect(isInside(root, path.join(root, '..', 'other'))).toBe(false);
    expect(isInside(root, path.join(root, '..config'))).toBe(true);
  });

  it('compares paths regardless of case on Windows only', () => {
    const windows = process.platform === 'win32';
    expect(isInside(root, path.join(root.toLowerCase(), 'inbox'))).toBe(windows);
    expect(isInside(root.toUpperCase(), path.join(root, 'inbox'))).toBe(windows);
    expect(isInside(root.toUpperCase(), `${root.toLowerCase()}x`)).toBe(false);
  });
});
