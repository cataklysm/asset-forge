import { describe, expect, it } from 'vitest';
import {
  AssetAssignmentSchema,
  AssetRelationViewSchema,
  FileRecordSchema,
  IpcErrorSchema,
  NameInputSchema,
  PageRequestSchema,
  ProjectMemberSchema,
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
    };
    expect(FileRecordSchema.parse(record)).toEqual(record);
  });
});

describe('ipcContract', () => {
  it('rejects files:list limits outside 1..200', () => {
    const { request } = ipcContract['files:list'];
    expect(request.safeParse({ limit: 0, offset: 0 }).success).toBe(false);
    expect(request.safeParse({ limit: 201, offset: 0 }).success).toBe(false);
    expect(request.safeParse({ limit: 200, offset: 0 }).success).toBe(true);
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
