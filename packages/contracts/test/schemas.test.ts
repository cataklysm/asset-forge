import { describe, expect, it } from 'vitest';
import {
  AssetAssignmentSchema,
  AssetDetailSchema,
  AssetRelationViewSchema,
  AssetSummarySchema,
  AssetWorkflowSchema,
  AssignManyResultSchema,
  FileBatchResultSchema,
  FileRecordSchema,
  FileScopeSchema,
  IpcErrorSchema,
  NameInputSchema,
  normalizeTagName,
  normalizeTagPrefix,
  PageRequestSchema,
  ProjectMemberSchema,
  ProjectSummarySchema,
  SetCoverRequestSchema,
  WORKSPACE_FORMAT_VERSION,
  WorkspaceManifestSchema,
  GENERATION_PROMPT_MAX,
  GenerationSchema,
  IMAGE_ANSWER_MAX_BYTES,
  IMAGE_INPUT_MAX_BYTES,
  IMAGE_INPUT_MAX_PIXELS,
  IMAGE_INPUT_MIN_PIXELS,
  MAX_FILE_GENERATIONS,
  MAX_RECENT_PROMPTS,
  StartGenerationResultSchema,
  StartGenerationSchema,
  UPSCALE_MAX_PIXELS,
  ipcContract,
} from '../src/index';

const uuid = '3f2b8c1e-5d4a-4b6e-8f10-1a2b3c4d5e6f';
const now = '2026-11-25T10:00:00.000Z';

describe('WorkspaceManifestSchema', () => {
  const valid = { id: uuid, formatVersion: WORKSPACE_FORMAT_VERSION, name: 'Demo', createdAt: now };

  it('parses a valid manifest', () => {
    expect(WorkspaceManifestSchema.parse(valid)).toEqual(valid);
  });

  it('rejects formatVersion 0', () => {
    expect(WorkspaceManifestSchema.safeParse({ ...valid, formatVersion: 0 }).success).toBe(false);
  });

  it('rejects a non-UUID id', () => {
    expect(WorkspaceManifestSchema.safeParse({ ...valid, id: 'nope' }).success).toBe(false);
  });
});

describe('FileRecordSchema', () => {
  it('parses a pending record with null size and hash', () => {
    const record = {
      id: uuid,
      storageId: uuid,
      assetId: null,
      role: null,
      originalName: 'a.png',
      relativePath: 'files/a.png',
      mimeType: 'image/png',
      sizeBytes: null,
      sha256: null,
      status: 'pending',
      error: null,
      importedAt: now,
      previewable: true,
      openable: true,
      kind: 'image',
      width: null,
      height: null,
      tags: [],
      hasProposal: false,
      deletedAt: null,
      trashedAssetId: null,
      trashedAssetName: null,
      trashedRole: null,
    };
    expect(FileRecordSchema.parse(record)).toEqual(record);
    const { kind: _k, ...withoutKind } = record;
    expect(() => FileRecordSchema.parse(withoutKind)).toThrow();
    const { previewable: _p, ...withoutPreviewable } = record;
    const { openable: _o, ...withoutOpenable } = record;
    expect(() => FileRecordSchema.parse(withoutPreviewable)).toThrow();
    expect(() => FileRecordSchema.parse(withoutOpenable)).toThrow();
    const { deletedAt: _d, ...withoutDeletedAt } = record;
    expect(() => FileRecordSchema.parse(withoutDeletedAt)).toThrow();
  });

  it('parses a trashed record with its origin', () => {
    const record = {
      id: uuid,
      storageId: uuid,
      assetId: null,
      role: null,
      originalName: 'a.png',
      relativePath: '.assetforge/trash/a.png',
      mimeType: 'image/png',
      sizeBytes: 3,
      sha256: null,
      status: 'complete',
      error: null,
      importedAt: now,
      previewable: true,
      openable: false,
      kind: 'image',
      width: null,
      height: null,
      tags: [],
      hasProposal: false,
      deletedAt: now,
      trashedAssetId: uuid,
      trashedAssetName: 'Oak',
      trashedRole: 'reference',
    };
    expect(FileRecordSchema.parse(record)).toEqual(record);
    expect(FileRecordSchema.safeParse({ ...record, trashedRole: 'bogus' }).success).toBe(false);
    expect(FileRecordSchema.safeParse({ ...record, trashedAssetId: 'nope' }).success).toBe(false);
  });
});

describe('FileScopeSchema', () => {
  it('accepts the trash scope', () => {
    expect(FileScopeSchema.safeParse({ kind: 'trash' }).success).toBe(true);
    expect(ipcContract['files:list'].request.safeParse({ limit: 10, offset: 0, scope: { kind: 'trash' } }).success).toBe(true);
  });
});

describe('ipcContract', () => {
  it('rejects files:list limits outside 1..200', () => {
    const { request } = ipcContract['files:list'];
    expect(request.safeParse({ limit: 0, offset: 0, scope: { kind: 'all' } }).success).toBe(false);
    expect(request.safeParse({ limit: 201, offset: 0, scope: { kind: 'all' } }).success).toBe(false);
    expect(request.safeParse({ limit: 200, offset: 0, scope: { kind: 'all' } }).success).toBe(true);
  });

  it('rejects files:import with empty sourcePaths', () => {
    expect(ipcContract['files:import'].request.safeParse({ sourcePaths: [] }).success).toBe(false);
  });

  it('files:import takes an optional boolean unpackArchives', () => {
    const request = ipcContract['files:import'].request;
    expect(request.safeParse({ sourcePaths: ['C:\\in\\a.zip'] }).success).toBe(true);
    expect(request.safeParse({ sourcePaths: ['C:\\in\\a.zip'], unpackArchives: true }).success).toBe(true);
    expect(request.safeParse({ sourcePaths: ['C:\\in\\a.zip'], unpackArchives: false }).success).toBe(true);
    expect(request.safeParse({ sourcePaths: ['C:\\in\\a.zip'], unpackArchives: 'yes' }).success).toBe(false);
  });

  it('an import result requires entryName', () => {
    const response = ipcContract['files:import'].response;
    const result = { sourcePath: 'C:\\in\\a.zip', file: null, error: 'This archive contains no files', duplicateOf: [] };
    expect(response.safeParse([result]).success).toBe(false);
    expect(response.safeParse([{ ...result, entryName: null }]).success).toBe(true);
    expect(response.safeParse([{ ...result, entryName: 'tex/a.png' }]).success).toBe(true);
  });
});

describe('NameInputSchema', () => {
  it('trims and rejects whitespace-only names', () => {
    expect(NameInputSchema.parse('  Gabriella ')).toBe('Gabriella');
    expect(NameInputSchema.safeParse('   ').success).toBe(false);
    expect(NameInputSchema.safeParse('a'.repeat(201)).success).toBe(false);
  });
});

describe('PageRequestSchema', () => {
  it('rejects limit 0, limit 201, a negative offset and fractions', () => {
    expect(PageRequestSchema.safeParse({ limit: 1, offset: 0 }).success).toBe(true);
    expect(PageRequestSchema.safeParse({ limit: 0, offset: 0 }).success).toBe(false);
    expect(PageRequestSchema.safeParse({ limit: 201, offset: 0 }).success).toBe(false);
    expect(PageRequestSchema.safeParse({ limit: 10, offset: -1 }).success).toBe(false);
    expect(PageRequestSchema.safeParse({ limit: 1.5, offset: 0 }).success).toBe(false);
    expect(PageRequestSchema.safeParse({ limit: 10, offset: 0.5 }).success).toBe(false);
  });
});

describe('IpcErrorSchema', () => {
  it('rejects an unknown code', () => {
    expect(IpcErrorSchema.safeParse({ code: 'not_found', message: 'm' }).success).toBe(true);
    expect(IpcErrorSchema.safeParse({ code: 'bogus', message: 'm' }).success).toBe(false);
  });
});

describe('assignment and relation views', () => {
  const asset = {
    id: uuid,
    name: 'A',
    typeId: uuid,
    description: '',
    status: 'draft',
    createdAt: now,
    updatedAt: now,
  };
  const project = {
    id: uuid,
    name: 'P',
    description: '',
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
  const member = {
    projectId: uuid,
    assetId: uuid,
    priority: 'normal',
    intendedUse: '',
    approvalStatus: 'pending',
    notes: '',
    assignedAt: now,
    updatedAt: now,
    asset,
  };
  const relation = {
    fromAssetId: uuid,
    toAssetId: uuid,
    kind: 'uses',
    createdAt: now,
    direction: 'outgoing',
    other: asset,
  };

  it('ProjectMemberSchema accepts a sample and rejects an unknown priority', () => {
    expect(ProjectMemberSchema.safeParse(member).success).toBe(true);
    expect(ProjectMemberSchema.safeParse({ ...member, priority: 'urgent' }).success).toBe(false);
  });

  it('AssetRelationViewSchema accepts a sample and rejects an unknown kind', () => {
    expect(AssetRelationViewSchema.safeParse(relation).success).toBe(true);
    expect(AssetRelationViewSchema.safeParse({ ...relation, kind: 'owns' }).success).toBe(false);
  });

  it('AssetAssignmentSchema embeds the project', () => {
    const { asset: _omit, ...base } = member;
    expect(AssetAssignmentSchema.safeParse({ ...base, project }).success).toBe(true);
  });
});

describe('library IPC requests', () => {
  it('assets:create rejects a whitespace-only name', () => {
    const request = ipcContract['assets:create'].request;
    expect(request.safeParse({ name: '   ', typeId: uuid }).success).toBe(false);
    expect(request.safeParse({ name: ' Pump ', typeId: uuid }).success).toBe(true);
  });

  it('assets:update rejects unknown patch keys', () => {
    const request = ipcContract['assets:update'].request;
    expect(request.safeParse({ id: uuid, patch: { status: 'in_review' } }).success).toBe(true);
    expect(request.safeParse({ id: uuid, patch: { id: uuid } }).success).toBe(false);
  });

  it('files:list requires a scope', () => {
    const request = ipcContract['files:list'].request;
    expect(request.safeParse({ limit: 10, offset: 0 }).success).toBe(false);
    expect(request.safeParse({ limit: 10, offset: 0, scope: { kind: 'inbox' } }).success).toBe(true);
  });

  it('files:list accepts query, tagNames, role and kind within their limits', () => {
    const request = ipcContract['files:list'].request;
    const base = { limit: 10, offset: 0, scope: { kind: 'inbox' } };
    const full = { ...base, query: 'x'.repeat(200), tagNames: Array.from({ length: 10 }, (_, i) => `t${i}`), role: 'texture', kind: 'model' };
    expect(request.parse(full)).toEqual(full);
    expect(request.safeParse({ ...base, query: 'x'.repeat(201) }).success).toBe(false);
    expect(request.safeParse({ ...base, tagNames: Array.from({ length: 11 }, (_, i) => `t${i}`) }).success).toBe(false);
    expect(request.safeParse({ ...base, tagNames: ['x'.repeat(201)] }).success).toBe(false);
    expect(request.safeParse({ ...base, role: 'nope' }).success).toBe(false);
    expect(request.safeParse({ ...base, kind: 'nope' }).success).toBe(false);
  });

  it('projects:list accepts query, status and tagNames within their limits', () => {
    const request = ipcContract['projects:list'].request;
    const base = { limit: 10, offset: 0 };
    const full = { ...base, query: 'x'.repeat(200), status: 'on_hold', tagNames: Array.from({ length: 10 }, (_, i) => `t${i}`) };
    expect(request.parse(base)).toEqual(base);
    expect(request.parse(full)).toEqual(full);
    expect(request.safeParse({ ...base, query: 'x'.repeat(201) }).success).toBe(false);
    expect(request.safeParse({ ...base, status: 'nope' }).success).toBe(false);
    expect(request.safeParse({ ...base, tagNames: Array.from({ length: 11 }, (_, i) => `t${i}`) }).success).toBe(false);
    expect(request.safeParse({ ...base, tagNames: ['x'.repeat(201)] }).success).toBe(false);
  });

  it('a project summary requires assetCount and imageCount and accepts matchedTags', () => {
    const base = { id: uuid, name: 'P', description: '', status: 'active', createdAt: now, updatedAt: now, assetCount: 1 };
    expect(ProjectSummarySchema.safeParse(base).success).toBe(false);
    expect(ProjectSummarySchema.safeParse({ ...base, imageCount: 2 }).success).toBe(true);
    expect(ProjectSummarySchema.safeParse({ ...base, imageCount: -1 }).success).toBe(false);
    expect(
      ProjectSummarySchema.safeParse({
        ...base,
        imageCount: 0,
        matchedTags: [{ name: 'oak', displayName: 'Oak', onAsset: false, onFiles: true }],
      }).success,
    ).toBe(true);
  });
});

describe('workflows', () => {
  const step = {
    id: uuid,
    key: 'concept',
    name: 'Concept',
    position: 0,
    mandatory: true,
    state: 'done',
    notes: '',
    updatedAt: now,
    completedAt: now,
  };
  const workflow = {
    id: uuid,
    assetId: uuid,
    templateId: uuid,
    templateName: 'Character',
    templateVersion: 1,
    createdAt: now,
    progress: { done: 1, total: 1 },
    steps: [step],
  };

  it('AssetWorkflowSchema accepts a well-formed workflow and rejects an unknown step state', () => {
    expect(AssetWorkflowSchema.safeParse(workflow).success).toBe(true);
    expect(AssetWorkflowSchema.safeParse({ ...workflow, steps: [{ ...step, state: 'blocked' }] }).success).toBe(false);
  });

  it('AssetSummarySchema accepts workflowProgress null and { done, total }', () => {
    const summary = {
      id: uuid,
      name: 'A',
      typeId: uuid,
      description: '',
      status: 'draft',
      createdAt: now,
      updatedAt: now,
      projectCount: 0,
      fileCount: 0,
      coverFileId: null,
      tags: [],
      coverTags: [],
    };
    expect(AssetSummarySchema.safeParse({ ...summary, workflowProgress: null }).success).toBe(true);
    expect(AssetSummarySchema.safeParse({ ...summary, workflowProgress: { done: 2, total: 5 } }).success).toBe(true);
    expect(AssetSummarySchema.safeParse(summary).success).toBe(false);
  });

  it('an asset summary requires tags and coverTags and accepts matchedTags', () => {
    const base = {
      id: uuid,
      name: 'A',
      typeId: uuid,
      description: '',
      status: 'draft',
      createdAt: now,
      updatedAt: now,
      projectCount: 0,
      fileCount: 0,
      workflowProgress: null,
      coverFileId: null,
    };
    expect(AssetSummarySchema.safeParse(base).success).toBe(false);
    expect(AssetSummarySchema.safeParse({ ...base, tags: [], coverTags: [] }).success).toBe(true);
    expect(
      AssetSummarySchema.safeParse({
        ...base,
        tags: [],
        coverTags: [],
        matchedTags: [{ name: 'oak', displayName: 'Oak', onAsset: true, onFiles: false }],
      }).success,
    ).toBe(true);
  });
});

describe('asset cover', () => {
  const asset = {
    id: uuid,
    name: 'A',
    typeId: uuid,
    description: '',
    status: 'draft',
    createdAt: now,
    updatedAt: now,
  };
  const summary = { ...asset, projectCount: 0, fileCount: 1, workflowProgress: null, tags: [], coverTags: [] };

  it('AssetSummarySchema requires coverFileId as a uuid or null', () => {
    expect(AssetSummarySchema.safeParse({ ...summary, coverFileId: uuid }).success).toBe(true);
    expect(AssetSummarySchema.safeParse({ ...summary, coverFileId: null }).success).toBe(true);
    expect(AssetSummarySchema.safeParse({ ...summary, coverFileId: 'files/a.png' }).success).toBe(false);
    expect(AssetSummarySchema.safeParse(summary).success).toBe(false);
  });

  it('AssetDetailSchema requires coverFileId and coverIsChosen', () => {
    expect(AssetDetailSchema.safeParse({ ...asset, coverFileId: uuid, coverIsChosen: true, tags: [], sources: [] }).success).toBe(true);
    expect(AssetDetailSchema.safeParse({ ...asset, coverFileId: null, coverIsChosen: false, tags: [], sources: [] }).success).toBe(true);
    expect(AssetDetailSchema.safeParse({ ...asset, coverFileId: null, tags: [], sources: [] }).success).toBe(false);
    expect(AssetDetailSchema.safeParse({ ...asset, coverIsChosen: false, tags: [], sources: [] }).success).toBe(false);
    expect(AssetDetailSchema.safeParse({ ...asset, coverFileId: null, coverIsChosen: false, sources: [] }).success).toBe(false);
  });

  it('AssetDetailSchema requires sources', () => {
    const source = { id: uuid, url: 'https://example.org/', createdAt: now };
    const detail = { ...asset, coverFileId: null, coverIsChosen: false, tags: [] };
    expect(AssetDetailSchema.safeParse({ ...detail, sources: [source] }).success).toBe(true);
    expect(AssetDetailSchema.safeParse(detail).success).toBe(false);
  });

  it('assets:addSource takes an asset id and a url of at most 2000 characters', () => {
    const add = ipcContract['assets:addSource'].request;
    expect(add.safeParse({ assetId: uuid, url: 'https://example.org' }).success).toBe(true);
    expect(add.safeParse({ assetId: uuid, url: 'x'.repeat(2001) }).success).toBe(false);
    expect(add.safeParse({ url: 'https://example.org' }).success).toBe(false);
  });

  it('assets:removeSource and assets:openSource take an asset id and a source id', () => {
    for (const channel of ['assets:removeSource', 'assets:openSource'] as const) {
      const request = ipcContract[channel].request;
      expect(request.safeParse({ assetId: uuid, sourceId: uuid }).success).toBe(true);
      expect(request.safeParse({ assetId: uuid, sourceId: 'x' }).success).toBe(false);
      expect(request.safeParse({ assetId: uuid }).success).toBe(false);
    }
  });

  it('SetCoverRequestSchema accepts a file id or null and requires both keys', () => {
    expect(SetCoverRequestSchema.safeParse({ assetId: uuid, fileId: uuid }).success).toBe(true);
    expect(SetCoverRequestSchema.safeParse({ assetId: uuid, fileId: null }).success).toBe(true);
    expect(SetCoverRequestSchema.safeParse({ assetId: uuid }).success).toBe(false);
    expect(SetCoverRequestSchema.safeParse({ assetId: 'x', fileId: null }).success).toBe(false);
  });
});

describe('normalizeTagName', () => {
  it('trims, collapses whitespace and lower-cases', () => {
    expect(normalizeTagName('  Sci   Fi ')).toBe('sci fi');
  });

  it('normalises decomposed input to NFC', () => {
    const acute = String.fromCodePoint(0x301);
    expect(normalizeTagName('e' + acute)).toBe(String.fromCodePoint(0xe9));
    expect(normalizeTagName('E' + acute)).toBe(normalizeTagName(String.fromCodePoint(0xc9)));
  });

  it('normalises to NFC again after lower-casing', () => {
    // J + caron has no composed capital, but j + caron composes to U+01F0.
    expect(normalizeTagName('J̌')).toBe('ǰ');
    expect(normalizeTagName('J̌')).toBe(normalizeTagName('ǰ'));
    expect(normalizeTagPrefix('J̌')).toBe('ǰ');
  });

  it('returns null for empty or blank input', () => {
    expect(normalizeTagName('')).toBeNull();
    expect(normalizeTagName('   ')).toBeNull();
  });

  it('counts code points against the 64 limit', () => {
    expect(normalizeTagName('a' + String.fromCodePoint(0x1f600).repeat(63))).not.toBeNull();
    expect(normalizeTagName('a' + String.fromCodePoint(0x1f600).repeat(64))).toBeNull();
  });

  it('returns null for text without a letter or digit', () => {
    expect(normalizeTagName('!!!')).toBeNull();
    expect(normalizeTagName('  -- ')).toBeNull();
    expect(normalizeTagName(String.fromCodePoint(0x1f600, 0x1f333))).toBeNull();
  });

  it('accepts text with at least one letter or digit', () => {
    expect(normalizeTagName('c++')).toBe('c++');
    expect(normalizeTagName('3d')).toBe('3d');
    expect(normalizeTagName('ÄÖ')).toBe('äö');
  });
});

describe('tag channels', () => {
  it('bounds the suggestion limit and the tag name length', () => {
    const suggest = ipcContract['tags:suggest'].request;
    expect(suggest.safeParse({ prefix: '', limit: 1 }).success).toBe(true);
    expect(suggest.safeParse({ prefix: '', limit: 50 }).success).toBe(true);
    expect(suggest.safeParse({ prefix: '', limit: 0 }).success).toBe(false);
    expect(suggest.safeParse({ prefix: '', limit: 51 }).success).toBe(false);
    expect(suggest.safeParse({ prefix: '', limit: 1.5 }).success).toBe(false);
    const id = '3f2b8c1e-5d4a-4b6e-8f10-1a2b3c4d5e6f';
    expect(ipcContract['assets:addTag'].request.safeParse({ assetId: id, name: 'x'.repeat(201) }).success).toBe(false);
  });

  it('tags:usage takes free text up to 200 characters', () => {
    const usage = ipcContract['tags:usage'].request;
    expect(usage.safeParse({ name: 'Front View' }).success).toBe(true);
    expect(usage.safeParse({ name: '' }).success).toBe(true);
    expect(usage.safeParse({ name: 'x'.repeat(201) }).success).toBe(false);
  });

  it('tags:rename requires a boolean merge', () => {
    const rename = ipcContract['tags:rename'].request;
    expect(rename.safeParse({ from: 'front view', to: 'Front', merge: false }).success).toBe(true);
    expect(rename.safeParse({ from: 'front view', to: 'Front' }).success).toBe(false);
    expect(rename.safeParse({ from: 'front view', to: 'Front', merge: 'yes' }).success).toBe(false);
  });
});

describe('file batch channels', () => {
  const uuidN = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

  it.each([[[]], [Array.from({ length: 1001 }, (_, i) => uuidN(i))], [[uuidN(1), uuidN(1)]]])(
    'file id lists of length 0, 1001 or with duplicates are rejected',
    (ids) => {
      expect(ipcContract['files:assignMany'].request.safeParse({ fileIds: ids, assetId: uuidN(9), role: 'reference' }).success).toBe(false);
      expect(ipcContract['files:addTagMany'].request.safeParse({ fileIds: ids, name: 'oak' }).success).toBe(false);
      expect(ipcContract['files:removeTagMany'].request.safeParse({ fileIds: ids, name: 'oak' }).success).toBe(false);
    },
  );

  it('accepts 1 and 1000 distinct ids and bounds the tag name', () => {
    const many = Array.from({ length: 1000 }, (_, i) => uuidN(i));
    expect(ipcContract['files:assignMany'].request.safeParse({ fileIds: many, assetId: uuidN(9), role: 'reference' }).success).toBe(true);
    expect(ipcContract['files:addTagMany'].request.safeParse({ fileIds: [uuidN(1)], name: 'oak' }).success).toBe(true);
    expect(ipcContract['files:removeTagMany'].request.safeParse({ fileIds: [uuidN(1)], name: 'x'.repeat(201) }).success).toBe(false);
  });

  it('an assignMany item carries either a file or an error', () => {
    const response = ipcContract['files:assignMany'].response;
    expect(
      response.safeParse({ items: [{ fileId: uuidN(1), file: null, error: { code: 'not_found', message: 'm' } }] }).success,
    ).toBe(true);
    expect(response.safeParse({ items: [{ fileId: uuidN(1), file: null, error: { code: 'bogus', message: 'm' } }] }).success).toBe(false);
  });
});

describe('trash channels', () => {
  const uuidN = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const channels = ['files:trashMany', 'files:restoreMany', 'files:purgeMany'] as const;

  it.each(channels)('%s accepts 1 and 1000 distinct ids', (channel) => {
    const { request } = ipcContract[channel];
    expect(request.safeParse({ fileIds: [uuidN(1)] }).success).toBe(true);
    expect(request.safeParse({ fileIds: Array.from({ length: 1000 }, (_, i) => uuidN(i)) }).success).toBe(true);
  });

  it.each(channels)('%s rejects 0, 1001 and duplicate ids', (channel) => {
    const { request } = ipcContract[channel];
    expect(request.safeParse({ fileIds: [] }).success).toBe(false);
    expect(request.safeParse({ fileIds: Array.from({ length: 1001 }, (_, i) => uuidN(i)) }).success).toBe(false);
    expect(request.safeParse({ fileIds: [uuidN(1), uuidN(1)] }).success).toBe(false);
  });

  it.each(channels)('%s answers per-item results; a purged item has neither file nor error', (channel) => {
    const { response } = ipcContract[channel];
    expect(response.safeParse({ items: [{ fileId: uuidN(1), file: null, error: null }] }).success).toBe(true);
    expect(
      response.safeParse({ items: [{ fileId: uuidN(1), file: null, error: { code: 'invalid_operation', message: 'm' } }] })
        .success,
    ).toBe(true);
  });

  it('AssignManyResultSchema is the neutral batch result', () => {
    expect(AssignManyResultSchema).toBe(FileBatchResultSchema);
  });

  it('trash:empty and trash:summary take an empty request and answer counts', () => {
    expect(ipcContract['trash:empty'].request.safeParse({}).success).toBe(true);
    expect(ipcContract['trash:empty'].response.safeParse({ purged: 2, failed: 0 }).success).toBe(true);
    expect(ipcContract['trash:empty'].response.safeParse({ purged: -1, failed: 0 }).success).toBe(false);
    expect(ipcContract['trash:empty'].response.safeParse({ purged: 1.5, failed: 0 }).success).toBe(false);
    expect(ipcContract['trash:summary'].request.safeParse({}).success).toBe(true);
    expect(ipcContract['trash:summary'].response.safeParse({ count: 0 }).success).toBe(true);
    expect(ipcContract['trash:summary'].response.safeParse({ count: -1 }).success).toBe(false);
  });
});

describe('generation studio', () => {
  const generation = {
    id: uuid,
    kind: 'edit',
    status: 'pending',
    errorCode: null,
    providerId: uuid,
    providerName: 'Venice',
    providerKind: 'venice',
    model: 'qwen-image',
    prompt: 'Make it night',
    parameters: { v: 1, aspectRatio: null, resolution: null, safeMode: true },
    jobId: uuid,
    jobStatus: 'queued',
    createdAt: now,
    finishedAt: null,
    inputs: [{ fileId: uuid, name: 'oak.png', sha256: 'a'.repeat(64), trashed: false }],
    outputs: [],
    promptId: null,
    promptVersionId: null,
    promptTitle: null,
    promptVersionNumber: null,
    promptVariables: null,
  };

  it('the constants', () => {
    expect(GENERATION_PROMPT_MAX).toBe(8000);
    expect(IMAGE_INPUT_MIN_PIXELS).toBe(65_536);
    expect(IMAGE_INPUT_MAX_PIXELS).toBe(33_177_600);
    expect(IMAGE_INPUT_MAX_BYTES).toBe(25_000_000);
    expect(IMAGE_ANSWER_MAX_BYTES).toBe(100 * 1024 ** 2);
    expect(UPSCALE_MAX_PIXELS).toBe(100_000_000);
    expect(MAX_RECENT_PROMPTS).toBe(20);
    expect(MAX_FILE_GENERATIONS).toBe(200);
  });

  it('StartGenerationSchema accepts an edit without provider, aspect ratio and resolution', () => {
    const edit = { kind: 'edit', fileId: uuid, model: 'qwen-image', prompt: 'Make it night', safeMode: true };
    expect(StartGenerationSchema.safeParse(edit).success).toBe(true);
    expect(StartGenerationSchema.safeParse({ ...edit, providerId: uuid, aspectRatio: '1:1', resolution: '1K' }).success).toBe(true);
    expect(ipcContract['generations:start'].request.safeParse(edit).success).toBe(true);
  });

  it('StartGenerationSchema refuses an edit without safe mode', () => {
    expect(StartGenerationSchema.safeParse({ kind: 'edit', fileId: uuid, model: 'm', prompt: 'p' }).success).toBe(false);
  });

  it('StartGenerationSchema takes an upscale of 2 or 4 only', () => {
    expect(StartGenerationSchema.safeParse({ kind: 'upscale', fileId: uuid, scale: 2 }).success).toBe(true);
    expect(StartGenerationSchema.safeParse({ kind: 'upscale', fileId: uuid, scale: 4, providerId: uuid }).success).toBe(true);
    expect(StartGenerationSchema.safeParse({ kind: 'upscale', fileId: uuid, scale: 3 }).success).toBe(false);
    expect(StartGenerationSchema.safeParse({ kind: 'other', fileId: uuid, scale: 2 }).success).toBe(false);
  });

  it('GenerationSchema parses an output without file and a generation without job status', () => {
    expect(GenerationSchema.safeParse(generation).success).toBe(true);
    const finished = {
      ...generation,
      status: 'succeeded',
      jobStatus: null,
      finishedAt: now,
      outputs: [{ fileId: null, name: 'oak edit 1.png', sha256: 'b'.repeat(64), trashed: false }],
    };
    expect(GenerationSchema.safeParse(finished).success).toBe(true);
    const upscale = { ...generation, kind: 'upscale', model: null, prompt: null, parameters: { v: 1, scale: 4 } };
    expect(GenerationSchema.safeParse(upscale).success).toBe(true);
    expect(GenerationSchema.safeParse({ ...generation, status: 'running' }).success).toBe(false);
  });

  it('StartGenerationResultSchema is the generation or a job error code', () => {
    expect(StartGenerationResultSchema.safeParse({ ok: true, generation }).success).toBe(true);
    expect(StartGenerationResultSchema.safeParse({ ok: false, code: 'provider_unauthorized' }).success).toBe(true);
    expect(StartGenerationResultSchema.safeParse({ ok: false, code: 'busy' }).success).toBe(false);
  });

  it('the generation channels', () => {
    expect(ipcContract['generations:forFile'].request.safeParse({ fileId: uuid }).success).toBe(true);
    expect(ipcContract['generations:forFile'].response.safeParse({ madeBy: null, results: [generation] }).success).toBe(true);
    expect(ipcContract['generations:retry'].request.safeParse({ generationId: uuid }).success).toBe(true);
    expect(ipcContract['generations:retry'].response.safeParse(generation).success).toBe(true);
    expect(ipcContract['generations:remove'].request.safeParse({ generationId: 'x' }).success).toBe(false);
    expect(ipcContract['generations:recentPrompts'].request.safeParse({}).success).toBe(true);
    expect(ipcContract['generations:recentPrompts'].response.safeParse({ prompts: ['a'] }).success).toBe(true);
    expect(
      ipcContract['generations:recentPrompts'].response.safeParse({ prompts: Array.from({ length: 21 }, () => 'a') }).success,
    ).toBe(false);
  });
});
