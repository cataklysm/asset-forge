import { describe, expect, it } from 'vitest';
import { RelationKindSchema } from '@assetforge/contracts';
import { label, relationLabel } from '../src/renderer/src/labels.js';

describe('label', () => {
  it.each([
    ['in_progress', 'In progress'],
    ['variant_of', 'Variant of'],
    ['draft', 'Draft'],
    ['on_hold', 'On hold'],
  ])('%s -> %s', (value, expected) => {
    expect(label(value)).toBe(expected);
  });
});

describe('relationLabel', () => {
  it.each([
    ['uses', 'outgoing', 'Uses'],
    ['variant_of', 'outgoing', 'Variant of'],
    ['part_of', 'outgoing', 'Part of'],
    ['derived_from', 'outgoing', 'Derived from'],
    ['uses', 'incoming', 'Used by'],
    ['variant_of', 'incoming', 'Has variant'],
    ['part_of', 'incoming', 'Has part'],
    ['derived_from', 'incoming', 'Source of'],
  ] as const)('%s %s -> %s', (kind, direction, expected) => {
    expect(relationLabel(kind, direction)).toBe(expected);
  });

  it('covers every relation kind', () => {
    expect(RelationKindSchema.options).toHaveLength(4);
  });
});
