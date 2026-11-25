import { describe, expect, it } from 'vitest';
import {
  AssetAssignmentSchema,
  AssetDetailSchema,
  AssetRelationViewSchema,
  AssetSummarySchema,
  AssetWorkflowSchema,
  FileRecordSchema,
  IpcErrorSchema,
  NameInputSchema,
  normalizeTagName,
  normalizeTagPrefix,
  PageRequestSchema,
  ProjectMemberSchema,
  SetCoverRequestSchema,
  WORKSPACE_FORMAT_VERSION,
  WorkspaceManifestSchema,
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
      tags: [],
    };
    expect(FileRecordSchema.parse(record)).toEqual(record);
    const { kind: _k, ...withoutKind } = record;
    expect(() => FileRecordSchema.parse(withoutKind)).toThrow();
    const { previewable: _p, ...withoutPreviewable } = record;
    const { openable: _o, ...withoutOpenable } = record;
    expect(() => FileRecordSchema.parse(withoutPreviewable)).toThrow();
    expect(() => FileRecordSchema.parse(withoutOpenable)).toThrow();
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
    expect(AssetDetailSchema.safeParse({ ...asset, coverFileId: uuid, coverIsChosen: true, tags: [] }).success).toBe(true);
    expect(AssetDetailSchema.safeParse({ ...asset, coverFileId: null, coverIsChosen: false, tags: [] }).success).toBe(true);
    expect(AssetDetailSchema.safeParse({ ...asset, coverFileId: null, tags: [] }).success).toBe(false);
    expect(AssetDetailSchema.safeParse({ ...asset, coverIsChosen: false, tags: [] }).success).toBe(false);
    expect(AssetDetailSchema.safeParse({ ...asset, coverFileId: null, coverIsChosen: false }).success).toBe(false);
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
    expect(normalizeTagName(String.fromCodePoint(0x1f600).repeat(64))).not.toBeNull();
    expect(normalizeTagName(String.fromCodePoint(0x1f600).repeat(65))).toBeNull();
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
});
