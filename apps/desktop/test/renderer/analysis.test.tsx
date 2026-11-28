import { describe, expect, it, vi } from 'vitest';
import {
  analysable,
  analysableFiles,
  enqueueTitle,
  NONE_ANALYSABLE,
  singleAnalysable,
} from '../../src/renderer/src/analysis';
import { fileMenuItems, type FileActionContext } from '../../src/renderer/src/file-actions';
import { selectAll } from '../../src/renderer/src/selection';
import { fileRecord, nonImageRecord } from './fixtures';

const labels = (ctx: FileActionContext, file = fileRecord()) => fileMenuItems(file, ctx).map((item) => item.label);

describe('analysis', () => {
  it('only complete previewable images are analysable', () => {
    const png = fileRecord({ originalName: 'a.png' });
    const pending = fileRecord({ originalName: 'b.png', status: 'pending', sha256: null });
    const blend = nonImageRecord('c.blend');
    expect([png, pending, blend].map(analysable)).toEqual([true, false, false]);
    expect(analysableFiles(selectAll([blend, png, pending]))).toEqual([png]);
    expect(NONE_ANALYSABLE).toBe('None of the selected files is an image that can be analysed');
  });

  it('the file menu offers Analyse after Show in folder for a complete image when the host gives onAnalyse', () => {
    const onAnalyse = vi.fn();
    const ctx: FileActionContext = { cover: null, onDetails: () => {}, onAnalyse };
    const items = fileMenuItems(fileRecord(), ctx);
    expect(items.map((item) => item.label)).toEqual(['Details', 'Open externally', 'Show in folder', 'Analyse']);
    const analyse = items.at(-1)!;
    expect(analyse.title).toBe('Tag this image with the vision model');
    analyse.onSelect();
    expect(onAnalyse).toHaveBeenCalledTimes(1);

    expect(labels(ctx, fileRecord({ status: 'pending', sha256: null }))).not.toContain('Analyse');
    expect(labels(ctx, nonImageRecord('tree.blend'))).not.toContain('Analyse');
    expect(labels({ cover: null, onDetails: () => {} })).not.toContain('Analyse');
  });

  it('the menu adds Review tags with a proposal and Image to prompt, both after Analyse', () => {
    const onReviewTags = vi.fn();
    const onImageToPrompt = vi.fn();
    const ctx: FileActionContext = {
      cover: null,
      onDetails: () => {},
      onAnalyse: () => {},
      onReviewTags,
      onImageToPrompt,
    };
    expect(labels(ctx)).toEqual(['Details', 'Open externally', 'Show in folder', 'Analyse', 'Image to prompt']);
    const items = fileMenuItems(fileRecord({ hasProposal: true }), ctx);
    expect(items.map((item) => item.label)).toEqual([
      'Details',
      'Open externally',
      'Show in folder',
      'Analyse',
      'Review tags',
      'Image to prompt',
    ]);
    items.find((item) => item.label === 'Review tags')!.onSelect();
    items.find((item) => item.label === 'Image to prompt')!.onSelect();
    expect(onReviewTags).toHaveBeenCalledTimes(1);
    expect(onImageToPrompt).toHaveBeenCalledTimes(1);
    expect(labels(ctx, nonImageRecord('tree.blend', { hasProposal: true }))).not.toContain('Image to prompt');
  });

  it('a blocked provider disables Analyse and Image to prompt with the reason, never Review tags', () => {
    const blocked = 'Not configured';
    const ctx: FileActionContext = {
      cover: null,
      onDetails: () => {},
      onAnalyse: () => {},
      onReviewTags: () => {},
      onImageToPrompt: () => {},
      analysisBlocked: blocked,
    };
    const items = fileMenuItems(fileRecord({ hasProposal: true }), ctx);
    const byLabel = (name: string) => items.find((item) => item.label === name)!;
    expect(byLabel('Analyse')).toMatchObject({ disabled: true, title: blocked });
    expect(byLabel('Image to prompt')).toMatchObject({ disabled: true, title: blocked });
    expect(byLabel('Review tags').disabled).toBeUndefined();
  });

  it('singleAnalysable is the only selected file when it is an analysable image', () => {
    const png = fileRecord();
    expect(singleAnalysable(selectAll([png]))).toBe(png);
    expect(singleAnalysable(selectAll([png, fileRecord()]))).toBeNull();
    expect(singleAnalysable(selectAll([nonImageRecord('a.pdf')]))).toBeNull();
    expect(singleAnalysable(selectAll([]))).toBeNull();
  });

  it('enqueueTitle counts the queued files and each skip reason that is not zero', () => {
    expect(
      enqueueTitle({ enqueued: 3, skipped: { notFound: 0, notAnalysable: 0, alreadyQueued: 0, alreadyAnalysed: 0 } }),
    ).toBe('3 queued');
    expect(
      enqueueTitle({ enqueued: 0, skipped: { notFound: 1, notAnalysable: 2, alreadyQueued: 3, alreadyAnalysed: 4 } }),
    ).toBe('0 queued, 4 already analysed, 3 already queued, 2 not analysable, 1 not found');
  });
});
