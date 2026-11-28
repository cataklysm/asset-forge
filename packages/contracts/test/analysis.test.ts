import { describe, expect, test } from 'vitest';
import {
  AnalysisPreviewSchema,
  AnalysisTargetSchema,
  AnalyzeFilePayloadSchema,
  AssetListFilterSchema,
  DescribeResultSchema,
  EnqueueAnalysisResultSchema,
  FileListFilterSchema,
  FileRecordSchema,
  ModelNameSchema,
  ProposalViewSchema,
  ipcContract,
  isRetryableJobError,
} from '../src/index';

const uuid = (n: number) => `3f2b8c1e-5d4a-4b6e-8f10-${n.toString(16).padStart(12, '0')}`;

describe('analysis payload', () => {
  test('v1 and v2 payloads parse', () => {
    expect(AnalyzeFilePayloadSchema.safeParse({ version: 1 }).success).toBe(true);
    expect(AnalyzeFilePayloadSchema.safeParse({ version: 2, model: 'qwen', mode: 'apply' }).success).toBe(true);
    expect(AnalyzeFilePayloadSchema.safeParse({ version: 2, model: 'qwen', mode: 'propose' }).success).toBe(true);
  });

  test('a v2 payload needs a model and a known mode', () => {
    expect(AnalyzeFilePayloadSchema.safeParse({ version: 2, mode: 'apply' }).success).toBe(false);
    expect(AnalyzeFilePayloadSchema.safeParse({ version: 2, model: '', mode: 'apply' }).success).toBe(false);
    expect(AnalyzeFilePayloadSchema.safeParse({ version: 2, model: 'qwen', mode: 'review' }).success).toBe(false);
    expect(AnalyzeFilePayloadSchema.safeParse({ version: 3, model: 'qwen', mode: 'apply' }).success).toBe(false);
  });

  test('a model name has 1 to 200 characters', () => {
    expect(ModelNameSchema.safeParse('a').success).toBe(true);
    expect(ModelNameSchema.safeParse('a'.repeat(200)).success).toBe(true);
    expect(ModelNameSchema.safeParse('').success).toBe(false);
    expect(ModelNameSchema.safeParse('a'.repeat(201)).success).toBe(false);
  });

  test('the new job codes are not retryable', () => {
    expect(isRetryableJobError('provider_unauthorized')).toBe(false);
    expect(isRetryableJobError('provider_not_configured')).toBe(false);
  });
});

describe('analysis targets', () => {
  test('each target kind parses', () => {
    const targets = [
      { kind: 'files', fileIds: [uuid(1), uuid(2)] },
      {
        kind: 'fileFilter',
        filter: { scope: { kind: 'inbox' }, query: 'tree', tagNames: ['oak'], role: 'reference', kind: 'image' },
      },
      { kind: 'fileFilter', filter: { scope: { kind: 'asset', assetId: uuid(3) } } },
      { kind: 'asset', assetId: uuid(4) },
      { kind: 'assetFilter', filter: {} },
      {
        kind: 'assetFilter',
        filter: { typeId: uuid(5), status: 'draft', fileRole: 'reference', fileKind: 'image', tagNames: ['oak'] },
      },
    ];
    for (const target of targets)
      expect(AnalysisTargetSchema.safeParse(target).success, JSON.stringify(target)).toBe(true);
  });

  test('a files target holds 1 to 1000 distinct ids', () => {
    expect(AnalysisTargetSchema.safeParse({ kind: 'files', fileIds: [] }).success).toBe(false);
    const many = Array.from({ length: 1001 }, (_, i) => uuid(i));
    expect(AnalysisTargetSchema.safeParse({ kind: 'files', fileIds: many }).success).toBe(false);
    expect(AnalysisTargetSchema.safeParse({ kind: 'files', fileIds: many.slice(0, 1000) }).success).toBe(true);
    expect(AnalysisTargetSchema.safeParse({ kind: 'files', fileIds: [uuid(1), uuid(1)] }).success).toBe(false);
  });

  test('an unknown kind or a bad id is refused', () => {
    expect(AnalysisTargetSchema.safeParse({ kind: 'project', projectId: uuid(1) }).success).toBe(false);
    expect(AnalysisTargetSchema.safeParse({ kind: 'asset', assetId: 'nope' }).success).toBe(false);
  });

  test('the filters are the filter parts of files:list and assets:list', () => {
    expect(FileListFilterSchema.safeParse({ scope: { kind: 'all' } }).success).toBe(true);
    expect(FileListFilterSchema.safeParse({}).success).toBe(false);
    expect(AssetListFilterSchema.safeParse({ fileKind: 'model' }).success).toBe(true);
    const files = ipcContract['files:list'].request;
    expect(
      files.safeParse({ limit: 10, offset: 0, scope: { kind: 'all' }, role: 'reference', hasProposal: true }).success,
    ).toBe(true);
    expect(files.safeParse({ limit: 10, offset: 0, scope: { kind: 'all' }, hasProposal: 'yes' }).success).toBe(false);
    const assets = ipcContract['assets:list'].request;
    expect(
      assets.safeParse({ limit: 10, offset: 0, query: 'oak', fileRole: 'reference', fileKind: 'image' }).success,
    ).toBe(true);
  });

  test('analysis:enqueue takes a target, a model, a mode and force', () => {
    const request = ipcContract['analysis:enqueue'].request;
    const target = { kind: 'files', fileIds: [uuid(1)] };
    expect(request.safeParse({ target, model: 'qwen', mode: 'apply', force: false }).success).toBe(true);
    expect(request.safeParse({ target, model: 'qwen', mode: 'propose', force: true }).success).toBe(true);
    expect(request.safeParse({ target, mode: 'apply', force: false }).success).toBe(false);
    expect(request.safeParse({ target, model: 'qwen', mode: 'apply' }).success).toBe(false);
    expect(request.safeParse({ fileIds: [uuid(1)] }).success).toBe(false);
  });
});

describe('analysis results', () => {
  test('preview and enqueue results are counts', () => {
    expect(
      AnalysisPreviewSchema.safeParse({ analysable: 3, alreadyAnalysed: 1, alreadyQueued: 0, notAnalysable: 2 })
        .success,
    ).toBe(true);
    expect(
      AnalysisPreviewSchema.safeParse({ analysable: -1, alreadyAnalysed: 1, alreadyQueued: 0, notAnalysable: 2 })
        .success,
    ).toBe(false);
    const skipped = { notFound: 0, notAnalysable: 1, alreadyQueued: 2, alreadyAnalysed: 3 };
    expect(EnqueueAnalysisResultSchema.safeParse({ enqueued: 4, skipped }).success).toBe(true);
    expect(EnqueueAnalysisResultSchema.safeParse({ enqueued: 4, skipped: [] }).success).toBe(false);
  });

  test('a proposal view carries its model, age, staleness and tags', () => {
    const view = {
      model: 'qwen',
      promptName: 'General',
      createdAt: '2026-11-26T10:00:00.000Z',
      stale: false,
      tags: [{ name: 'oak', displayName: 'Oak' }],
    };
    expect(ProposalViewSchema.safeParse(view).success).toBe(true);
    expect(ProposalViewSchema.safeParse({ ...view, stale: undefined }).success).toBe(false);
    const tags = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `tag ${i}`, displayName: `tag ${i}` }));
    expect(ProposalViewSchema.safeParse({ ...view, tags: tags(50) }).success).toBe(true);
    expect(ProposalViewSchema.safeParse({ ...view, tags: tags(51) }).success).toBe(false);
  });

  test('accepting a proposal takes one to fifty non-empty names', () => {
    const request = ipcContract['analysis:acceptProposal'].request;
    const fileId = '3f2b8c1e-5d4a-4b6e-8f10-1a2b3c4d5e6f';
    const createdAt = '2026-11-28T10:00:00.000Z';
    expect(request.safeParse({ fileId, createdAt, names: ['oak'] }).success).toBe(true);
    expect(request.safeParse({ fileId, createdAt, names: [] }).success).toBe(false);
    expect(request.safeParse({ fileId, createdAt, names: [''] }).success).toBe(false);
    expect(request.safeParse({ fileId, createdAt, names: Array.from({ length: 51 }, (_, i) => `t${i}`) }).success).toBe(
      false,
    );
  });

  test('accepting a proposal names the proposal by its creation time', () => {
    const request = ipcContract['analysis:acceptProposal'].request;
    const fileId = '3f2b8c1e-5d4a-4b6e-8f10-1a2b3c4d5e6f';
    expect(request.safeParse({ fileId, names: ['oak'] }).success).toBe(false);
    expect(request.safeParse({ fileId, createdAt: 'yesterday', names: ['oak'] }).success).toBe(false);
  });

  test('a describe result is a text or a code', () => {
    expect(DescribeResultSchema.safeParse({ ok: true, text: 'An oak.' }).success).toBe(true);
    for (const code of ['cancelled', 'busy', 'provider_unauthorized', 'provider_timeout']) {
      expect(DescribeResultSchema.safeParse({ ok: false, code }).success, code).toBe(true);
    }
    expect(DescribeResultSchema.safeParse({ ok: false, code: 'nope' }).success).toBe(false);
    expect(DescribeResultSchema.safeParse({ ok: true }).success).toBe(false);
  });

  test('a file record tells whether a proposal waits', () => {
    expect(FileRecordSchema.shape.hasProposal.safeParse(true).success).toBe(true);
  });

  test('every new channel is in the contract', () => {
    for (const channel of [
      'providers:list',
      'providers:save',
      'providers:delete',
      'providers:listModels',
      'analysis:preview',
      'analysis:enqueue',
      'analysis:getProposal',
      'analysis:acceptProposal',
      'analysis:discardProposal',
      'analysis:describe',
      'analysis:cancelDescribe',
      'jobs:resume',
      'jobs:waitingByProvider',
      'jobs:reroute',
    ]) {
      expect(Object.hasOwn(ipcContract, channel), channel).toBe(true);
    }
  });
});
