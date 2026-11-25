import type { FileRecord } from '@assetforge/contracts';
import { describe, expect, it } from 'vitest';
import {
  MAX_SELECTION,
  NO_SELECTION,
  clickSelect,
  dropSelected,
  eligibleFiles,
  refreshSelected,
  selectAll,
  sharedTags,
  toggleSelect,
  type FileSelection,
  type ItemAt,
} from '../src/renderer/src/selection.js';
import { fileRecord, tagOf } from './renderer/fixtures.js';

const files = (n: number): FileRecord[] => Array.from({ length: n }, (_, i) => fileRecord({ id: `f${i}` }));
const list = files(10);
const at: ItemAt = (index) => list[index] ?? null;
const ids = (s: FileSelection) => [...s.selected.keys()];
const withTags = (...names: string[]) => fileRecord({ tags: names.map((n) => tagOf(n)) });
const plain = { ctrl: false, shift: false };
const ctrl = { ctrl: true, shift: false };
const shift = { ctrl: false, shift: true };

describe('selection model', () => {
  it('click selects one, ctrl toggles, shift selects the range from the anchor', () => {
    let s = clickSelect(NO_SELECTION, 2, at, plain);
    expect(ids(s)).toEqual(['f2']);
    expect(s.anchor).toBe(2);
    s = clickSelect(s, 4, at, ctrl);
    expect(ids(s)).toEqual(['f2', 'f4']);
    expect(s.anchor).toBe(4);
    s = clickSelect(s, 0, at, shift);
    expect(ids(s)).toEqual(['f0', 'f1', 'f2', 'f3', 'f4']);
    expect(s.anchor).toBe(4);
    s = clickSelect(s, 6, at, shift);
    expect(ids(s)).toEqual(['f4', 'f5', 'f6']);
    s = clickSelect(s, 5, at, ctrl);
    expect(ids(s)).toEqual(['f4', 'f6']);
    s = clickSelect(s, 7, at, plain);
    expect(ids(s)).toEqual(['f7']);
  });

  it('shift without an anchor acts like a plain click', () => {
    const s = clickSelect(NO_SELECTION, 3, at, shift);
    expect(ids(s)).toEqual(['f3']);
    expect(s.anchor).toBe(3);
  });

  it('a click on an item that is not loaded changes nothing', () => {
    const s = clickSelect(NO_SELECTION, 2, at, plain);
    expect(clickSelect(s, 50, at, plain)).toBe(s);
    expect(toggleSelect(s, 50, at)).toBe(s);
  });

  it('a shift range skips items that are not loaded and is capped', () => {
    const holes: ItemAt = (index) => (index % 2 === 0 ? fileRecord({ id: `g${index}` }) : null);
    const s = clickSelect({ selected: new Map(), anchor: 0 }, 6, holes, shift);
    expect(ids(s)).toEqual(['g0', 'g2', 'g4', 'g6']);
    const many = files(1500);
    const big = clickSelect({ selected: new Map(), anchor: 1400 }, 0, (i) => many[i] ?? null, shift);
    expect(big.selected.size).toBe(MAX_SELECTION);
    // The items next to the anchor are kept.
    expect(big.selected.has('f1400')).toBe(true);
    expect(big.selected.has('f0')).toBe(false);
  });

  it('toggleSelect adds and removes one item and sets the anchor', () => {
    let s = toggleSelect(NO_SELECTION, 1, at);
    s = toggleSelect(s, 3, at);
    expect(ids(s)).toEqual(['f1', 'f3']);
    expect(s.anchor).toBe(3);
    s = toggleSelect(s, 1, at);
    expect(ids(s)).toEqual(['f3']);
  });

  it('ctrl does not add beyond the cap', () => {
    const many = files(MAX_SELECTION + 1);
    const full = selectAll(many);
    const s = toggleSelect(full, MAX_SELECTION, (i) => many[i] ?? null);
    expect(s.selected.size).toBe(MAX_SELECTION);
    expect(s.selected.has(`f${MAX_SELECTION}`)).toBe(false);
  });

  it('selectAll caps at 1000', () => {
    const s = selectAll(files(1200));
    expect(s.selected.size).toBe(1000);
    expect(s.anchor).toBeNull();
    expect(s.selected.has('f999')).toBe(true);
  });

  it('refreshSelected replaces records by id and keeps the order', () => {
    const s = selectAll(list.slice(0, 3));
    const renamed = fileRecord({ id: 'f1', originalName: 'renamed.png' });
    const next = refreshSelected(s, [renamed, fileRecord({ id: 'other' })]);
    expect(ids(next)).toEqual(['f0', 'f1', 'f2']);
    expect(next.selected.get('f1')!.originalName).toBe('renamed.png');
  });

  it('dropSelected removes ids and keeps the selection when nothing matches', () => {
    const s = selectAll(list.slice(0, 3));
    expect(ids(dropSelected(s, ['f1']))).toEqual(['f0', 'f2']);
    expect(dropSelected(s, ['nope'])).toBe(s);
  });

  it('eligibleFiles excludes pending and failed files', () => {
    const s = selectAll([
      fileRecord({ id: 'a', status: 'pending' }),
      fileRecord({ id: 'b' }),
      fileRecord({ id: 'c', status: 'failed' }),
      fileRecord({ id: 'd' }),
    ]);
    expect(eligibleFiles(s).map((f) => f.id)).toEqual(['b', 'd']);
  });

  it('sharedTags keeps only tags every file carries', () => {
    expect(sharedTags([withTags('oak', 'bark'), withTags('bark')]).map((t) => t.name)).toEqual(['bark']);
    expect(sharedTags([withTags('oak'), withTags('bark')])).toEqual([]);
    expect(sharedTags([withTags('oak', 'bark')]).map((t) => t.name)).toEqual(['oak', 'bark']);
    expect(sharedTags([])).toEqual([]);
  });
});
