import { describe, expect, it } from 'vitest';
import { JobStatusSchema, RelationKindSchema } from '@assetforge/contracts';
import { archiveCountLabel, JOB_STATUS_LABELS, jobStatusLabel, label, relationLabel } from '../src/renderer/src/labels.js';

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

describe('jobStatusLabel', () => {
  it.each([
    ['queued', 'Queued'],
    ['running', 'Running'],
    ['retry_wait', 'Retrying'],
    ['waiting_remote', 'Waiting'],
    ['succeeded', 'Done'],
    ['failed', 'Failed'],
    ['cancelled', 'Cancelled'],
  ] as const)('%s -> %s', (status, expected) => {
    expect(jobStatusLabel(status)).toBe(expected);
  });

  it('covers every job status, in the filter order', () => {
    expect(JobStatusSchema.options).toHaveLength(7);
    expect(Object.keys(JOB_STATUS_LABELS)).toEqual([
      'queued',
      'running',
      'retry_wait',
      'waiting_remote',
      'succeeded',
      'failed',
      'cancelled',
    ]);
  });
});

describe('archiveCountLabel', () => {
  it.each([
    [2, '2 archives'],
    [5, '5 archives'],
  ])('%i -> %s', (count, expected) => {
    expect(archiveCountLabel(count)).toBe(expected);
  });
});
