import { describe, expect, it } from 'vitest';
import {
  FileRecordSchema,
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
      assetId: null,
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
