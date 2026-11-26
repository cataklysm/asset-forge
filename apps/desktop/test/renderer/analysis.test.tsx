import { describe, expect, it, vi } from 'vitest';
import { analysable, analysableFiles, NONE_ANALYSABLE, startAnalysis, TEMP_MODEL } from '../../src/renderer/src/analysis';
import { fileMenuItems, type FileActionContext } from '../../src/renderer/src/file-actions';
import { selectAll } from '../../src/renderer/src/selection';
import { installFakeApi } from './fake-api';
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

  it('startAnalysis sends the ids as an applied file target and counts the skipped files', async () => {
    const a = fileRecord({ originalName: 'a.png' });
    const b = fileRecord({ originalName: 'b.png' });
    const c = fileRecord({ originalName: 'c.png' });
    const api = installFakeApi({
      'analysis:enqueue': () => ({
        enqueued: 1,
        skipped: { notFound: 1, notAnalysable: 0, alreadyQueued: 1, alreadyAnalysed: 0 },
      }),
    });
    const result = await startAnalysis([a, b, c]);
    expect(api.calls).toEqual([
      {
        channel: 'analysis:enqueue',
        request: { target: { kind: 'files', fileIds: [a.id, b.id, c.id] }, model: TEMP_MODEL, mode: 'apply', force: true },
      },
    ]);
    expect(result).toEqual({ title: '1 queued, 2 skipped', failures: [] });
  });
});
