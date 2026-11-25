import { describe, expect, it } from 'vitest';
import { formatProgress, pickTemplate } from '../src/renderer/src/progress.js';

describe('formatProgress', () => {
  it('formats done and total', () => {
    expect(formatProgress({ done: 3, total: 5 })).toBe('3 / 5');
    expect(formatProgress({ done: 0, total: 0 })).toBe('0 / 0');
  });
  it('shows an en dash without a workflow', () => {
    expect(formatProgress(null)).toBe('–');
  });
});

describe('pickTemplate', () => {
  const ids = ['a', 'b', 'c'];
  it('keeps the user choice', () => {
    expect(pickTemplate(ids, 'c', 'b')).toBe('c');
  });
  it('falls back to the type default, then the first template', () => {
    expect(pickTemplate(ids, '', 'b')).toBe('b');
    expect(pickTemplate(ids, '', null)).toBe('a');
    expect(pickTemplate(ids, 'x', 'y')).toBe('a');
  });
  it('returns an empty string without templates', () => {
    expect(pickTemplate([], '', null)).toBe('');
  });
});
