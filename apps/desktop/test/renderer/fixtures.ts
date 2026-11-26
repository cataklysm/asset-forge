import type { AssetSummary, FileRecord, IpcRequest, IpcResponse, ProjectSummary, TagAssignment, TagOrigin } from '@assetforge/contracts';
import { TEMP_MODEL } from '../../src/renderer/src/analysis';

let counter = 0;
/** Deterministic, unique UUID-shaped ids. */
export function nextId(): string {
  counter += 1;
  return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, '0')}`;
}

const NOW = '2026-01-01T00:00:00.000Z';

export function assetSummary(p: Partial<AssetSummary> = {}): AssetSummary {
  return {
    id: nextId(),
    name: 'Asset',
    typeId: nextId(),
    description: '',
    status: 'draft',
    createdAt: NOW,
    updatedAt: NOW,
    projectCount: 0,
    fileCount: 0,
    workflowProgress: null,
    coverFileId: null,
    tags: [],
    coverTags: [],
    ...p,
  };
}

export function fileRecord(p: Partial<FileRecord> = {}): FileRecord {
  return {
    id: nextId(),
    storageId: nextId(),
    assetId: null,
    role: null,
    originalName: 'file.png',
    relativePath: 'files/file.png',
    mimeType: 'image/png',
    sizeBytes: 1024,
    sha256: 'a'.repeat(64),
    status: 'complete',
    error: null,
    importedAt: NOW,
    previewable: true,
    openable: true,
    kind: 'image',
    width: null,
    height: null,
    tags: [],
    hasProposal: false,
    ...p,
  };
}

/** A completely imported file without a preview (e.g. `.pdf`, `.blend`). */
export function nonImageRecord(originalName: string, p: Partial<FileRecord> = {}): FileRecord {
  return fileRecord({
    originalName,
    relativePath: `files/${originalName}`,
    mimeType: 'application/octet-stream',
    previewable: false,
    kind: originalName.endsWith('.pdf') ? 'document' : 'model',
    ...p,
  });
}

export function projectSummary(p: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id: nextId(),
    name: 'Project',
    description: '',
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    assetCount: 0,
    imageCount: 0,
    ...p,
  };
}

export function tagOf(displayName: string, origin: TagOrigin = 'manual'): TagAssignment {
  return { name: displayName.toLowerCase(), displayName, origin };
}

export function pageOf<T>(items: T[], total: number = items.length): { items: T[]; total: number } {
  return { items, total };
}

export const NONE_SKIPPED: IpcResponse<'analysis:enqueue'>['skipped'] = {
  notFound: 0,
  notAnalysable: 0,
  alreadyQueued: 0,
  alreadyAnalysed: 0,
};

/** The analysis:enqueue request the renderer sends for these files. */
export function applyFiles(fileIds: string[]): IpcRequest<'analysis:enqueue'> {
  return { target: { kind: 'files', fileIds }, model: TEMP_MODEL, mode: 'apply', force: true };
}

/** An analysis:enqueue answer that queues every requested file. */
export function enqueueAll(r: IpcRequest<'analysis:enqueue'>): IpcResponse<'analysis:enqueue'> {
  return { enqueued: r.target.kind === 'files' ? r.target.fileIds.length : 0, skipped: NONE_SKIPPED };
}
