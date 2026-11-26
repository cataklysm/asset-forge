import { describe, expect, it } from 'vitest';
import { NO_SELECTION, type FileSelection } from '../src/renderer/src/selection.js';
import {
  renameInNames,
  renameInRecord,
  renameInSelection,
  renameInTags,
  type TagRename,
} from '../src/renderer/src/tag-rename.js';
import { fileRecord, tagOf } from './renderer/fixtures.js';

const toFront: TagRename = { from: 'front view', name: 'front', displayName: 'Front' };

describe('renameInTags', () => {
  it('renames an entry and keeps its origin', () => {
    const tags = [tagOf('oak'), tagOf('front view', 'ai')];
    expect(renameInTags(tags, toFront)).toEqual([tagOf('oak'), { name: 'front', displayName: 'Front', origin: 'ai' }]);
  });

  it('collapses source and target at the first position, manual when either was manual', () => {
    expect(renameInTags([tagOf('front view', 'ai'), tagOf('oak'), tagOf('front')], toFront)).toEqual([
      { name: 'front', displayName: 'Front', origin: 'manual' },
      tagOf('oak'),
    ]);
    expect(renameInTags([tagOf('front', 'ai'), tagOf('front view')], toFront)).toEqual([
      { name: 'front', displayName: 'Front', origin: 'manual' },
    ]);
    expect(renameInTags([tagOf('front view', 'ai'), tagOf('front', 'ai')], toFront)).toEqual([
      { name: 'front', displayName: 'Front', origin: 'ai' },
    ]);
  });

  it('gives an entry already named like the target the new display name', () => {
    expect(renameInTags([{ name: 'front', displayName: 'FRONT', origin: 'ai' }], toFront)).toEqual([
      { name: 'front', displayName: 'Front', origin: 'ai' },
    ]);
  });

  it('changes only the display name when the name stays', () => {
    const change: TagRename = { from: 'oak', name: 'oak', displayName: 'Oak' };
    expect(renameInTags([tagOf('oak', 'ai')], change)).toEqual([{ name: 'oak', displayName: 'Oak', origin: 'ai' }]);
  });

  it('returns the same array when nothing changes', () => {
    const tags = [tagOf('oak'), tagOf('bark')];
    expect(renameInTags(tags, toFront)).toBe(tags);
    const settled = [{ name: 'front', displayName: 'Front', origin: 'manual' as const }];
    expect(renameInTags(settled, toFront)).toBe(settled);
  });
});

describe('renameInRecord', () => {
  it('rewrites the tags of a record', () => {
    const file = fileRecord({ tags: [tagOf('front view')] });
    const next = renameInRecord(file, toFront);
    expect(next).not.toBe(file);
    expect(next.tags).toEqual([{ name: 'front', displayName: 'Front', origin: 'manual' }]);
    expect(next.id).toBe(file.id);
  });

  it('returns the same record when its tags are unchanged', () => {
    const file = fileRecord({ tags: [tagOf('oak')] });
    expect(renameInRecord(file, toFront)).toBe(file);
  });
});

describe('renameInSelection', () => {
  it('rewrites the selected records in place and keeps the anchor and the order', () => {
    const a = fileRecord({ tags: [tagOf('oak')] });
    const b = fileRecord({ tags: [tagOf('front view', 'ai'), tagOf('front')] });
    const sel: FileSelection = { selected: new Map([[a.id, a], [b.id, b]]), anchor: 3 };
    const next = renameInSelection(sel, toFront);
    expect(next).not.toBe(sel);
    expect(next.anchor).toBe(3);
    expect([...next.selected.keys()]).toEqual([a.id, b.id]);
    expect(next.selected.get(a.id)).toBe(a);
    expect(next.selected.get(b.id)?.tags).toEqual([{ name: 'front', displayName: 'Front', origin: 'manual' }]);
  });

  it('returns the same selection when no record changes', () => {
    const a = fileRecord({ tags: [tagOf('oak')] });
    const sel: FileSelection = { selected: new Map([[a.id, a]]), anchor: null };
    expect(renameInSelection(sel, toFront)).toBe(sel);
    expect(renameInSelection(NO_SELECTION, toFront)).toBe(NO_SELECTION);
  });
});

describe('renameInNames', () => {
  it('replaces the source in place without a duplicate', () => {
    expect(renameInNames(['a', 'front view', 'front'], toFront)).toEqual(['a', 'front']);
    expect(renameInNames(['front', 'a', 'front view'], toFront)).toEqual(['front', 'a']);
    expect(renameInNames(['front view', 'a'], toFront)).toEqual(['front', 'a']);
  });

  it('returns the same array when the source is absent', () => {
    const names = ['a', 'front'];
    expect(renameInNames(names, toFront)).toBe(names);
  });
});
