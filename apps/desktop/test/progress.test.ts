import { describe, expect, it } from 'vitest';
import { formatProgress } from '../src/renderer/src/progress.js';

describe('formatProgress', () => {
  it('formats done and total', () => {
    expect(formatProgress({ done: 3, total: 5 })).toBe('3 / 5');
    expect(formatProgress({ done: 0, total: 0 })).toBe('0 / 0');
  });
  it('shows an en dash without a workflow', () => {
    expect(formatProgress(null)).toBe('–');
  });
});
