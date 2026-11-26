import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { ACTIVE_JOB_STATUSES, ANALYZE_FILE_JOB } from '@assetforge/contracts';
import type {
  AnalysisPreview,
  AnalysisTarget,
  Asset,
  AssetAssignment,
  AssetList,
  AssetRelation,
  AssetRelationView,
  AssetType,
  FileKind,
  FileList,
  FileRecord,
  ImportStatus,
  MatchedTag,
  Project,
  ProjectAssignment,
  ProjectList,
  ProjectMemberList,
  TagAssignment,
  TagOrigin,
  TagSuggestion,
  AssetWorkflow,
  WorkflowProgress,
  WorkflowStep,
  WorkflowStepState,
  WorkflowTemplate,
  WorkspaceSummary,
} from '@assetforge/contracts';
import { automaticCover } from '../src/asset-cover.js';
import { trashFiles } from '../src/file-trash.js';
import type { WorkspaceSession } from '../src/session.js';
import { fileKind, isOpenable, isPreviewable } from '../src/media-types.js';
import { LAYOUT_DIRS } from '../src/paths.js';
import { foldSearchWord, searchWords, textWords } from '../src/search.js';
import {
  ArchiveNotReadableError,
  InvalidOperationError,
  NotFoundError,
  SourceNotReadableError,
  StorageUnreachableError,
  ValidationFailedError,
} from '../src/errors.js';
import type {
  AnalysisFingerprint,
  AnalysisTargetEntry,
  AnalysisTargetReader,
  ArchiveReader,
  AssetCover,
  AssetQuery,
  Proposal,
  AssetRelationRepository,
  AssetRepository,
  AssignmentKey,
  AssetTypeRepository,
  AssetWorkflowRepository,
  FileAnalysis,
  FileAnalysisRepository,
  NewWorkflowStep,
  StepContext,
  StepDefinitionInput,
  TemplateVersion,
  WorkflowTemplateRepository,
  FileMove,
  FileMoveRepository,
  FilePlacement,
  FileQuery,
  FileRepository,
  ImageProbe,
  ModelImageSource,
  OpenArchive,
  Page,
  ProjectAssetRepository,
  ProjectQuery,
  ProjectRepository,
  RelationKey,
  SourceFiles,
  Storage,
  StorageRef,
  StorageRepository,
  TagRepository,
  VisionProvider,
  WorkspaceDatabase,
  WorkspaceHost,
  WorkspaceMeta,
  WorkspaceMetaRepository,
  WorkspaceRegistry,
} from '../src/ports.js';
import { InMemoryJobRepository } from './memory-jobs.js';

/** In-memory storage. Files live in `files`, directories in `dirs` (relative, `/`-separated). */
export class InMemoryStorage implements Storage {
  readonly files = new Map<string, Buffer>();
  readonly dirs = new Set<string>();
  reachable = true;
  /** When set, `hashFile` returns this value instead of the real hash. */
  hashOverride: string | null = null;
  private readonly failures = new Map<keyof Storage, Error>();

  /** The next call to `method` rejects with `error` (once). */
  failNext(method: keyof Storage, error: Error): void {
    this.failures.set(method, error);
  }

  private async guard(method: keyof Storage): Promise<void> {
    const error = this.failures.get(method);
    if (error) {
      this.failures.delete(method);
      throw error;
    }
  }

  async isReachable(): Promise<boolean> {
    await this.guard('isReachable');
    return this.reachable;
  }

  async isEmptyOrMissing(): Promise<boolean> {
    await this.guard('isEmptyOrMissing');
    return this.files.size === 0 && this.dirs.size === 0;
  }

  async ensureLayout(): Promise<void> {
    await this.guard('ensureLayout');
    for (const dir of LAYOUT_DIRS) this.addDir(dir);
  }

  async readText(relPath: string): Promise<string | null> {
    await this.guard('readText');
    return this.files.get(relPath)?.toString('utf8') ?? null;
  }

  async writeText(relPath: string, text: string): Promise<void> {
    await this.guard('writeText');
    this.addParents(relPath);
    this.files.set(relPath, Buffer.from(text, 'utf8'));
  }

  async writeStream(relPath: string, source: Readable): Promise<{ sizeBytes: number; sha256: string }> {
    await this.guard('writeStream');
    if (this.files.has(relPath)) {
      source.destroy();
      throw new Error(`Target exists: ${relPath}`);
    }
    const chunks: Buffer[] = [];
    for await (const chunk of source) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const data = Buffer.concat(chunks);
    this.addParents(relPath);
    this.files.set(relPath, data);
    return { sizeBytes: data.length, sha256: sha256Of(data) };
  }

  async hashFile(relPath: string): Promise<string> {
    await this.guard('hashFile');
    const data = this.files.get(relPath);
    if (!data) throw new Error(`File not found: ${relPath}`);
    return this.hashOverride ?? sha256Of(data);
  }

  async move(from: string, to: string): Promise<void> {
    await this.guard('move');
    const data = this.files.get(from);
    if (!data) throw new Error(`File not found: ${from}`);
    if (this.files.has(to)) throw new Error(`Target exists: ${to}`);
    this.files.delete(from);
    this.addParents(to);
    this.files.set(to, data);
  }

  async exists(relPath: string): Promise<boolean> {
    await this.guard('exists');
    return this.files.has(relPath) || this.dirs.has(relPath);
  }

  async remove(relPath: string): Promise<void> {
    await this.guard('remove');
    this.files.delete(relPath);
  }

  async list(relDir: string): Promise<string[]> {
    await this.guard('list');
    const prefix = relDir === '' || relDir === '.' ? '' : `${relDir.replace(/\/+$/, '')}/`;
    const names = new Set<string>();
    for (const path of [...this.files.keys(), ...this.dirs]) {
      if (!path.startsWith(prefix) || path === prefix) continue;
      names.add(path.slice(prefix.length).split('/')[0]!);
    }
    return [...names];
  }

  async absolutePath(relPath: string): Promise<string> {
    await this.guard('absolutePath');
    if (!this.reachable) throw new StorageUnreachableError('The storage is not reachable');
    return `/memory/${relPath}`;
  }

  private addDir(dir: string): void {
    const parts = dir.split('/');
    for (let i = 1; i <= parts.length; i++) this.dirs.add(parts.slice(0, i).join('/'));
  }

  private addParents(relPath: string): void {
    const idx = relPath.lastIndexOf('/');
    if (idx > 0) this.addDir(relPath.slice(0, idx));
  }
}

function sha256Of(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Descending order of two strings. */
const desc = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0);

class InMemoryMeta implements WorkspaceMetaRepository {
  current: WorkspaceMeta | null = null;

  async get(): Promise<WorkspaceMeta | null> {
    return this.current;
  }

  async init(meta: WorkspaceMeta): Promise<void> {
    if (this.current !== null) throw new InvalidOperationError('The workspace row already exists');
    this.current = meta;
  }
}

class InMemoryStorages implements StorageRepository {
  readonly rows: StorageRef[] = [];

  async getPrimary(): Promise<StorageRef | null> {
    return this.rows[0] ?? null;
  }

  async ensurePrimary(r: { id: string; createdAt: string }): Promise<StorageRef> {
    if (this.rows.length === 0) this.rows.push({ id: r.id, kind: 'workspace_root', createdAt: r.createdAt });
    return this.rows[0]!;
  }
}

/** Chosen covers, assetId -> fileId; shared so a file placement can clear a cover like the database does. */
class CoverChoices extends Map<string, string> {}

/** Tags and both kinds of assignment. Assignments are kept in insertion order and sorted on read. */
class InMemoryTags implements TagRepository {
  readonly tags = new Map<string, { id: string; displayName: string }>(); // by normalised name
  readonly assetAssignments: { assetId: string; name: string; origin: TagOrigin }[] = [];
  readonly fileAssignments: { fileId: string; name: string; origin: TagOrigin }[] = [];

  private static sorted(rows: { name: string; origin: TagOrigin }[], tags: Map<string, { displayName: string }>): TagAssignment[] {
    return rows
      .map((r) => ({ name: r.name, displayName: tags.get(r.name)!.displayName, origin: r.origin }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0));
  }

  async suggest(q: { prefix: string; limit: number }): Promise<TagSuggestion[]> {
    const used = new Map<string, number>();
    // Mirrors the database: a file in the trash does not count.
    const liveFileAssignments = this.fileAssignments.filter((a) => !(this.files?.isTrashed(a.fileId) ?? false));
    for (const a of [...this.assetAssignments, ...liveFileAssignments]) used.set(a.name, (used.get(a.name) ?? 0) + 1);
    return [...used]
      .filter(([name]) => name.startsWith(q.prefix))
      .sort(([an, ac], [bn, bc]) => bc - ac || (an < bn ? -1 : an > bn ? 1 : 0))
      .slice(0, q.limit)
      .map(([name]) => ({ name, displayName: this.tags.get(name)!.displayName }));
  }

  ensureTag(r: { name: string; displayName: string; newId: string }): void {
    if (!this.tags.has(r.name)) this.tags.set(r.name, { id: r.newId, displayName: r.displayName });
  }

  async addToAsset(r: { assetId: string; name: string; displayName: string; origin: TagOrigin; newId: string; now: string }): Promise<void> {
    this.ensureTag(r);
    const list = this.assetAssignments;
    if (r.origin === 'manual') {
      const kept = list.filter((a) => !(a.assetId === r.assetId && a.name === r.name && a.origin === 'ai'));
      list.splice(0, list.length, ...kept);
    }
    if (!list.some((a) => a.assetId === r.assetId && a.name === r.name)) list.push({ assetId: r.assetId, name: r.name, origin: r.origin });
  }

  async removeFromAsset(r: { assetId: string; name: string }): Promise<void> {
    const list = this.assetAssignments;
    const kept = list.filter((a) => !(a.assetId === r.assetId && a.name === r.name));
    list.splice(0, list.length, ...kept);
  }

  async addToFile(r: { fileId: string; name: string; displayName: string; origin: TagOrigin; newId: string; now: string }): Promise<void> {
    this.ensureTag(r);
    const list = this.fileAssignments;
    if (r.origin === 'manual') {
      const kept = list.filter((a) => !(a.fileId === r.fileId && a.name === r.name && a.origin === 'ai'));
      list.splice(0, list.length, ...kept);
    }
    if (!list.some((a) => a.fileId === r.fileId && a.name === r.name)) list.push({ fileId: r.fileId, name: r.name, origin: r.origin });
  }

  async removeFromFile(r: { fileId: string; name: string }): Promise<void> {
    const list = this.fileAssignments;
    const kept = list.filter((a) => !(a.fileId === r.fileId && a.name === r.name));
    list.splice(0, list.length, ...kept);
  }

  /** Set by the database; the batches check and return file records. */
  files: InMemoryFiles | null = null;

  /** Throws for an unknown or incomplete file before anything is written, like one transaction. */
  private async requireCompleteFiles(fileIds: readonly string[]): Promise<void> {
    for (const id of fileIds) {
      const rec = this.files!.records.get(id);
      if (!rec) throw new NotFoundError(`File ${id} does not exist`);
      if (rec.status !== 'complete') throw new ValidationFailedError(`File ${id} is not completely imported`);
      if (rec.deletedAt !== null) throw new InvalidOperationError('The file is in the trash');
    }
  }

  private async recordsOf(fileIds: readonly string[]): Promise<FileRecord[]> {
    return Promise.all(fileIds.map(async (id) => (await this.files!.get(id))!));
  }

  async addToFiles(r: { fileIds: readonly string[]; name: string; displayName: string; origin: TagOrigin; newId: string; now: string }): Promise<FileRecord[]> {
    await this.requireCompleteFiles(r.fileIds);
    for (const fileId of r.fileIds) await this.addToFile({ ...r, fileId });
    return this.recordsOf(r.fileIds);
  }

  async removeFromFiles(r: { fileIds: readonly string[]; name: string }): Promise<FileRecord[]> {
    await this.requireCompleteFiles(r.fileIds);
    for (const fileId of r.fileIds) await this.removeFromFile({ ...r, fileId });
    return this.recordsOf(r.fileIds);
  }

  async listForAsset(assetId: string): Promise<TagAssignment[]> {
    return this.forAsset(assetId);
  }

  /** Set by the database; a rename rewrites the waiting proposals. */
  proposals: ProposalRows | null = null;

  async usage(name: string): Promise<{ displayName: string; assets: number; files: number } | null> {
    const tag = this.tags.get(name);
    if (!tag) return null;
    return {
      displayName: tag.displayName,
      assets: this.assetAssignments.filter((a) => a.name === name).length,
      // Mirrors the database: a file in the trash does not count.
      files: this.fileAssignments.filter((a) => a.name === name && !(this.files?.isTrashed(a.fileId) ?? false)).length,
    };
  }

  async rename(r: { from: string; name: string; displayName: string; merge: boolean }): Promise<{ merged: boolean }> {
    const source = this.tags.get(r.from);
    if (!source) throw new NotFoundError('Tag does not exist');
    if (r.from === r.name) {
      if (source.displayName !== r.displayName) {
        source.displayName = r.displayName;
        this.rewriteProposals(r);
      }
      return { merged: false };
    }
    const target = this.tags.get(r.name);
    if (target && !r.merge) throw new InvalidOperationError('A tag with this name already exists');
    // Moves each source link to the target; an owner carrying both keeps one link, manual when either was.
    const move = <T extends { name: string; origin: TagOrigin }>(list: T[], sameOwner: (a: T, b: T) => boolean): void => {
      const kept: T[] = [];
      for (const link of list) {
        if (link.name !== r.from) {
          kept.push(link);
          continue;
        }
        const other = list.find((a) => a.name === r.name && sameOwner(a, link));
        if (other === undefined) kept.push({ ...link, name: r.name });
        else if (link.origin === 'manual') other.origin = 'manual';
      }
      list.splice(0, list.length, ...kept);
    };
    move(this.assetAssignments, (a, b) => a.assetId === b.assetId);
    move(this.fileAssignments, (a, b) => a.fileId === b.fileId);
    this.tags.delete(r.from);
    if (target) target.displayName = r.displayName;
    else this.tags.set(r.name, { id: source.id, displayName: r.displayName });
    this.rewriteProposals(r);
    return { merged: target !== undefined };
  }

  /** Mirrors the database: every entry named `from` or `name` becomes `name` spelled `displayName`, first position wins. */
  private rewriteProposals(r: { from: string; name: string; displayName: string }): void {
    const touched = (t: { name: string }) => t.name === r.from || t.name === r.name;
    for (const [fileId, proposal] of this.proposals ?? []) {
      if (!proposal.tags.some((t) => touched(t) && (t.name !== r.name || t.displayName !== r.displayName))) continue;
      const tags: { name: string; displayName: string }[] = [];
      for (const t of proposal.tags) {
        const entry = touched(t) ? { name: r.name, displayName: r.displayName } : t;
        if (!tags.some((x) => x.name === entry.name)) tags.push(entry);
      }
      this.proposals!.set(fileId, { ...proposal, tags });
    }
  }

  forAsset(assetId: string): TagAssignment[] {
    return InMemoryTags.sorted(this.assetAssignments.filter((a) => a.assetId === assetId), this.tags);
  }

  forFile(fileId: string): TagAssignment[] {
    return InMemoryTags.sorted(this.fileAssignments.filter((a) => a.fileId === fileId), this.tags);
  }
}

/** Waiting tag proposals by file id; shared so a file record can report `hasProposal` like the database does. */
class ProposalRows extends Map<string, Proposal> {}

class InMemoryFiles implements FileRepository {
  /** Stored without tags; every method that returns a record attaches the current file tags and `hasProposal`. */
  readonly records = new Map<string, FileRecord>();
  /** Purge tombstones: ids of trashed files whose row is gone and whose binary may still be in the trash. */
  readonly purged = new Set<string>();

  constructor(
    private readonly covers: CoverChoices,
    private readonly tags: InMemoryTags,
    private readonly proposals: ProposalRows,
  ) {}

  /** Set by the database: the name of an asset, for `trashedAssetName`. */
  assetName: (assetId: string) => string | null = () => null;
  /** Set by the database: deletes every row that references a purged file, like the purge transaction. */
  onPurge: (fileId: string) => void = () => {};
  /** Set by the database: whether the file has an open move row. */
  hasMove: (fileId: string) => boolean = () => false;

  private withTags(rec: FileRecord): FileRecord {
    // Mirrors the database: a trashed file is never openable.
    return {
      ...rec,
      openable: rec.deletedAt === null && rec.openable,
      tags: this.tags.forFile(rec.id),
      hasProposal: this.proposals.has(rec.id),
      trashedAssetName: rec.trashedAssetId === null ? null : this.assetName(rec.trashedAssetId),
    };
  }

  /** True when the file exists and is in the trash. */
  isTrashed(id: string): boolean {
    return (this.records.get(id)?.deletedAt ?? null) !== null;
  }

  /** The commit of a `trash` move: remembers the origin, clears the placement and any chosen cover. */
  moveToTrash(id: string, r: { relativePath: string; deletedAt: string }): FileRecord {
    const rec = this.require(id);
    const next: FileRecord = {
      ...rec,
      trashedAssetId: rec.assetId,
      trashedRole: rec.role,
      assetId: null,
      role: null,
      deletedAt: r.deletedAt,
      relativePath: r.relativePath,
      openable: isOpenable(r.relativePath),
    };
    this.records.set(id, next);
    for (const [assetId, fileId] of this.covers) if (fileId === id) this.covers.delete(assetId);
    return this.withTags(next);
  }

  /** The commit of a `restore` move: places the file and clears the trash columns; no cover is set. */
  restoreFromTrash(id: string, placement: FilePlacement): FileRecord {
    const next: FileRecord = {
      ...this.require(id),
      ...placement,
      openable: isOpenable(placement.relativePath),
      deletedAt: null,
      trashedAssetId: null,
      trashedRole: null,
    };
    this.records.set(id, next);
    return this.withTags(next);
  }

  async insertPending(r: {
    id: string;
    storageId: string;
    originalName: string;
    relativePath: string;
    mimeType: string;
    importedAt: string;
    kind: FileKind;
  }): Promise<void> {
    this.records.set(r.id, {
      id: r.id,
      storageId: r.storageId,
      assetId: null,
      role: null,
      originalName: r.originalName,
      relativePath: r.relativePath,
      mimeType: r.mimeType,
      sizeBytes: null,
      sha256: null,
      status: 'pending',
      error: null,
      importedAt: r.importedAt,
      previewable: isPreviewable(r.mimeType),
      openable: isOpenable(r.relativePath),
      kind: r.kind,
      width: null,
      height: null,
      tags: [],
      hasProposal: false,
      deletedAt: null,
      trashedAssetId: null,
      trashedAssetName: null,
      trashedRole: null,
    });
  }

  async markComplete(id: string, r: { sizeBytes: number; sha256: string; width: number | null; height: number | null }): Promise<void> {
    const rec = this.require(id);
    this.records.set(id, { ...rec, status: 'complete', sizeBytes: r.sizeBytes, sha256: r.sha256, width: r.width, height: r.height, error: null });
  }

  async setDimensions(id: string, size: { width: number; height: number }): Promise<FileRecord> {
    const rec = { ...this.require(id), width: size.width, height: size.height };
    this.records.set(id, rec);
    return this.withTags(rec);
  }

  async markFailed(id: string, error: string): Promise<void> {
    const rec = this.require(id);
    this.records.set(id, { ...rec, status: 'failed', error });
  }

  async findCompleteBySha256(sha256: string): Promise<FileRecord[]> {
    return [...this.records.values()]
      .filter((r) => r.status === 'complete' && r.deletedAt === null && r.sha256 === sha256)
      .map((r) => this.withTags(r));
  }

  async listByStatus(status: ImportStatus): Promise<FileRecord[]> {
    return [...this.records.values()].filter((r) => r.status === status).map((r) => this.withTags(r));
  }

  async get(id: string): Promise<FileRecord | null> {
    const rec = this.records.get(id);
    return rec ? this.withTags(rec) : null;
  }

  async setPlacement(id: string, placement: FilePlacement): Promise<FileRecord> {
    const next = { ...this.require(id), ...placement, openable: isOpenable(placement.relativePath) };
    this.records.set(id, next);
    // Mirrors the database: a file that leaves an asset stops being that asset's chosen cover.
    for (const [assetId, fileId] of this.covers) {
      if (fileId === id && assetId !== placement.assetId) this.covers.delete(assetId);
    }
    return this.withTags(next);
  }

  async list(q: FileQuery): Promise<FileList> {
    const { scope } = q;
    const inScope = (r: FileRecord) =>
      scope.kind === 'trash'
        ? r.deletedAt !== null
        : r.deletedAt === null && (scope.kind === 'all' || r.assetId === (scope.kind === 'asset' ? scope.assetId : null));
    // Newest import first; the trash lists the newest deletion first.
    const order = (a: FileRecord, b: FileRecord) =>
      scope.kind === 'trash' ? desc(a.deletedAt!, b.deletedAt!) || desc(a.id, b.id) : desc(a.importedAt, b.importedAt) || desc(a.id, b.id);
    const words = (q.query === undefined ? [] : searchWords(q.query)).map(foldSearchWord);
    const tagsOf = (fileId: string) => this.tags.fileAssignments.filter((a) => a.fileId === fileId).map((a) => a.name);
    // Plan decision 1/2: a word is a substring of the folded name or a word prefix of a tag name.
    const matchesWord = (r: FileRecord, w: string) =>
      foldSearchWord(r.originalName).includes(w) ||
      tagsOf(r.id).some((name) => startsWithToken(textWords(name).map(foldSearchWord), w));
    const sorted = [...this.records.values()]
      .filter(inScope)
      .filter((r) => q.role === undefined || r.role === q.role)
      .filter((r) => q.kind === undefined || r.kind === q.kind)
      .filter((r) => (q.tagNames ?? []).every((name) => tagsOf(r.id).includes(name)))
      .filter((r) => q.hasProposal === undefined || this.proposals.has(r.id) === q.hasProposal)
      .filter((r) => words.every((w) => matchesWord(r, w)))
      .sort(order);
    return { items: sorted.slice(q.offset, q.offset + q.limit).map((r) => this.withTags(r)), total: sorted.length };
  }

  async purge(id: string): Promise<boolean> {
    const rec = this.records.get(id);
    if (!rec || (rec.deletedAt === null && rec.status !== 'failed')) return false;
    if (this.hasMove(id)) throw new InvalidOperationError('The file is being moved');
    this.onPurge(id);
    this.records.delete(id);
    if (rec.deletedAt !== null) this.purged.add(id);
    return true;
  }

  async listPurgedIds(): Promise<string[]> {
    return [...this.purged].sort();
  }

  async forgetPurge(id: string): Promise<void> {
    this.purged.delete(id);
  }

  async countTrashed(): Promise<number> {
    return [...this.records.values()].filter((r) => r.deletedAt !== null).length;
  }

  async listTrashedIds(): Promise<string[]> {
    return [...this.records.values()]
      .filter((r) => r.deletedAt !== null)
      .sort((a, b) => desc(a.deletedAt!, b.deletedAt!) || desc(a.id, b.id))
      .map((r) => r.id);
  }

  private require(id: string): FileRecord {
    const rec = this.records.get(id);
    if (!rec) throw new NotFoundError(`Unknown file id: ${id}`);
    return rec;
  }
}

/** Analysis rows by file id; `apply` writes the fake's tag data like the database transaction. */
class InMemoryAnalyses implements FileAnalysisRepository {
  readonly rows = new Map<string, FileAnalysis>();

  constructor(
    private readonly files: InMemoryFiles,
    private readonly tags: InMemoryTags,
    readonly proposals: ProposalRows,
  ) {}

  async get(fileId: string): Promise<FileAnalysis | null> {
    const row = this.rows.get(fileId);
    return row ? { ...row } : null;
  }

  private hasContent(fileId: string, sha256: string): boolean {
    const rec = this.files.records.get(fileId);
    // Mirrors the database: nothing is written to a file in the trash.
    return rec !== undefined && rec.status === 'complete' && rec.deletedAt === null && rec.sha256 === sha256;
  }

  async apply(r: {
    fileId: string;
    sha256: string;
    tags: readonly { name: string; displayName: string; newId: string }[];
    provider: string;
    model: string;
    promptVersion: number;
    promptName: string | null;
    now: string;
  }): Promise<boolean> {
    if (!this.hasContent(r.fileId, r.sha256)) return false;
    this.writeTags(r.fileId, r.tags);
    this.rows.set(r.fileId, {
      fileId: r.fileId,
      sha256: r.sha256,
      provider: r.provider,
      model: r.model,
      promptVersion: r.promptVersion,
      promptName: r.promptName,
      analysedAt: r.now,
    });
    this.proposals.delete(r.fileId);
    return true;
  }

  /** Replaces the file's AI tags with `tags`, leaving tags it carries manually alone. */
  private writeTags(fileId: string, tags: readonly { name: string; displayName: string; newId: string }[]): void {
    const assignments = this.tags.fileAssignments;
    const kept = assignments.filter((a) => !(a.fileId === fileId && a.origin === 'ai'));
    assignments.splice(0, assignments.length, ...kept);
    for (const t of tags) {
      this.tags.ensureTag(t);
      const carried = assignments.some((a) => a.fileId === fileId && a.name === t.name);
      if (!carried) assignments.push({ fileId, name: t.name, origin: 'ai' });
    }
  }

  async propose(r: Proposal): Promise<boolean> {
    if (!this.hasContent(r.fileId, r.sha256)) return false;
    this.proposals.set(r.fileId, structuredClone(r));
    return true;
  }

  async getProposal(fileId: string): Promise<(Proposal & { stale: boolean }) | null> {
    const proposal = this.proposals.get(fileId);
    if (!proposal) return null;
    return { ...structuredClone(proposal), stale: this.files.records.get(fileId)?.sha256 !== proposal.sha256 };
  }

  async acceptProposal(r: {
    fileId: string;
    sha256: string;
    tags: readonly { name: string; displayName: string; newId: string }[];
    now: string;
  }): Promise<boolean> {
    const proposal = this.proposals.get(r.fileId);
    if (!proposal) return false;
    if (r.tags.length === 0 || r.tags.some((t) => !proposal.tags.some((p) => p.name === t.name))) return false;
    // The proposal of a trashed file is kept for a restore; only a genuinely stale one is deleted.
    if (this.files.isTrashed(r.fileId)) return false;
    if (proposal.sha256 !== r.sha256 || !this.hasContent(r.fileId, r.sha256)) {
      this.proposals.delete(r.fileId);
      return false;
    }
    this.writeTags(r.fileId, r.tags);
    this.rows.set(r.fileId, {
      fileId: r.fileId,
      sha256: proposal.sha256,
      provider: proposal.provider,
      model: proposal.model,
      promptVersion: proposal.promptVersion,
      promptName: proposal.promptName,
      analysedAt: r.now,
    });
    this.proposals.delete(r.fileId);
    return true;
  }

  async discardProposal(fileId: string): Promise<void> {
    this.proposals.delete(fileId);
  }

  /** The fingerprint and the file's current sha256 equal its analysis row or its waiting proposal. */
  analysedWith(fileId: string, fingerprint: AnalysisFingerprint): boolean {
    const sha256 = this.files.records.get(fileId)?.sha256;
    const same = (row: AnalysisFingerprint & { sha256: string }) =>
      row.sha256 === sha256 &&
      row.provider === fingerprint.provider &&
      row.model === fingerprint.model &&
      row.promptVersion === fingerprint.promptVersion;
    const row = this.rows.get(fileId);
    const proposal = this.proposals.get(fileId);
    return (row !== undefined && same(row)) || (proposal !== undefined && same(proposal));
  }
}

/** Resolves analysis targets over the fake's rows, following the contract of the SQLite reader. */
class InMemoryAnalysisTargets implements AnalysisTargetReader {
  constructor(
    private readonly files: InMemoryFiles,
    private readonly assets: InMemoryAssets,
    private readonly analyses: InMemoryAnalyses,
    private readonly jobs: InMemoryJobRepository,
  ) {}

  /** How often `page` was called. */
  pageCalls = 0;

  private async fileIdsOf(target: AnalysisTarget): Promise<string[]> {
    const all = { offset: 0, limit: Number.MAX_SAFE_INTEGER };
    switch (target.kind) {
      case 'files':
        return target.fileIds.filter((id) => this.files.records.has(id));
      case 'fileFilter':
        return (await this.files.list({ ...target.filter, ...all })).items.map((f) => f.id);
      case 'asset':
        return [...this.files.records.values()].filter((f) => f.assetId === target.assetId).map((f) => f.id);
      case 'assetFilter': {
        const { fileRole, fileKind } = target.filter;
        const assetIds = new Set((await this.assets.list({ ...target.filter, ...all })).items.map((a) => a.id));
        return [...this.files.records.values()]
          .filter((f) => f.assetId !== null && assetIds.has(f.assetId))
          .filter((f) => (fileRole === undefined || f.role === fileRole) && (fileKind === undefined || f.kind === fileKind))
          .map((f) => f.id);
      }
    }
  }

  private async entries(r: { target: AnalysisTarget; fingerprint: AnalysisFingerprint; mimeTypes: readonly string[] }): Promise<AnalysisTargetEntry[]> {
    const ids = [...new Set(await this.fileIdsOf(r.target))].sort();
    return ids.map((fileId) => {
      const f = this.files.records.get(fileId)!;
      const analysable = f.status === 'complete' && f.deletedAt === null && r.mimeTypes.includes(f.mimeType) && f.sha256 !== null;
      return { fileId, analysable, analysed: analysable && this.analyses.analysedWith(fileId, r.fingerprint) };
    });
  }

  async page(r: {
    target: AnalysisTarget;
    fingerprint: AnalysisFingerprint;
    mimeTypes: readonly string[];
    afterId: string | null;
    limit: number;
  }): Promise<AnalysisTargetEntry[]> {
    this.pageCalls++;
    const entries = await this.entries(r);
    return entries.filter((e) => r.afterId === null || e.fileId > r.afterId).slice(0, r.limit);
  }

  async count(r: { target: AnalysisTarget; fingerprint: AnalysisFingerprint; mimeTypes: readonly string[] }): Promise<AnalysisPreview> {
    const result: AnalysisPreview = { analysable: 0, alreadyAnalysed: 0, alreadyQueued: 0, notAnalysable: 0 };
    const queued = new Set(
      this.jobs.rows
        .filter((j) => j.type === ANALYZE_FILE_JOB && j.fileId !== null && (ACTIVE_JOB_STATUSES as readonly string[]).includes(j.status))
        .map((j) => j.fileId),
    );
    for (const e of await this.entries(r)) {
      if (!e.analysable) result.notAnalysable++;
      else if (e.analysed) result.alreadyAnalysed++;
      else if (queued.has(e.fileId)) result.alreadyQueued++;
      else result.analysable++;
    }
    return result;
  }
}

class InMemoryFileMoves implements FileMoveRepository {
  readonly rows = new Map<string, FileMove>();

  constructor(private readonly files: InMemoryFiles) {}

  async begin(move: FileMove): Promise<void> {
    if (this.rows.has(move.fileId)) throw new InvalidOperationError(`File ${move.fileId} is already being moved`);
    this.rows.set(move.fileId, move);
  }

  async commit(fileId: string): Promise<FileRecord> {
    const move = this.rows.get(fileId);
    if (!move) throw new NotFoundError(`File ${fileId} has no move in progress`);
    const placement = { relativePath: move.targetRelativePath, assetId: move.targetAssetId, role: move.targetRole };
    let next: FileRecord;
    switch (move.kind) {
      case 'relocate':
        next = await this.files.setPlacement(fileId, placement);
        break;
      case 'trash':
        next = this.files.moveToTrash(fileId, { relativePath: move.targetRelativePath, deletedAt: move.createdAt });
        break;
      case 'restore':
        next = this.files.restoreFromTrash(fileId, placement);
        break;
    }
    this.rows.delete(fileId);
    return next;
  }

  async abort(fileId: string): Promise<void> {
    this.rows.delete(fileId);
  }

  async list(): Promise<FileMove[]> {
    return [...this.rows.values()].sort(
      (a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) || (a.fileId < b.fileId ? -1 : a.fileId > b.fileId ? 1 : 0),
    );
  }
}

class InMemoryAssetTypes implements AssetTypeRepository {
  readonly rows = new Map<string, AssetType>();

  async list(): Promise<AssetType[]> {
    return [...this.rows.values()].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  }

  async get(id: string): Promise<AssetType | null> {
    return this.rows.get(id) ?? null;
  }

  async insertMissing(types: AssetType[]): Promise<void> {
    for (const t of types) {
      if (![...this.rows.values()].some((r) => r.key === t.key)) this.rows.set(t.id, t);
    }
  }

  async setDefaultWorkflowTemplateIfUnset(typeKey: string, templateId: string): Promise<void> {
    const row = [...this.rows.values()].find((r) => r.key === typeKey);
    if (row && row.defaultWorkflowTemplateId === null) this.rows.set(row.id, { ...row, defaultWorkflowTemplateId: templateId });
  }

  /** Test-only: sets or clears the default template of the type with `typeKey`, replacing any existing one. */
  setDefaultWorkflowTemplate(typeKey: string, templateId: string | null): void {
    const row = [...this.rows.values()].find((r) => r.key === typeKey);
    if (!row) throw new Error(`Unknown asset type key: ${typeKey}`);
    this.rows.set(row.id, { ...row, defaultWorkflowTemplateId: templateId });
  }
}

type TemplateRow = { id: string; key: string; name: string; builtIn: boolean; createdAt: string };

class InMemoryWorkflowTemplates implements WorkflowTemplateRepository {
  readonly templates = new Map<string, TemplateRow>();
  readonly versions = new Map<string, TemplateVersion & { createdAt: string }>();

  private versionsOf(templateId: string): (TemplateVersion & { createdAt: string })[] {
    return [...this.versions.values()].filter((v) => v.templateId === templateId).sort((a, b) => b.version - a.version);
  }

  private view(t: TemplateRow): WorkflowTemplate | null {
    const latest = this.versionsOf(t.id)[0];
    return latest ? { id: t.id, key: t.key, name: t.name, builtIn: t.builtIn, latestVersion: latest.version } : null;
  }

  /** The step definition with `id` and the version it belongs to. */
  definition(id: string): { version: TemplateVersion; step: StepDefinitionInput } | null {
    for (const version of this.versions.values()) {
      const step = version.steps.find((s) => s.id === id);
      if (step) return { version, step };
    }
    return null;
  }

  async list(): Promise<WorkflowTemplate[]> {
    return [...this.templates.values()]
      .map((t) => this.view(t))
      .filter((t): t is WorkflowTemplate => t !== null)
      .sort(byNameThenId);
  }

  async get(id: string): Promise<WorkflowTemplate | null> {
    const t = this.templates.get(id);
    return t ? this.view(t) : null;
  }

  async findByKey(key: string): Promise<{ id: string } | null> {
    const t = [...this.templates.values()].find((r) => r.key === key);
    return t ? { id: t.id } : null;
  }

  async insertTemplate(t: TemplateRow): Promise<void> {
    if (this.templates.has(t.id) || [...this.templates.values()].some((r) => r.key === t.key)) {
      throw new Error('UNIQUE constraint failed: workflow_template');
    }
    this.templates.set(t.id, { ...t });
  }

  async hasVersion(templateId: string, version: number): Promise<boolean> {
    return this.versionsOf(templateId).some((v) => v.version === version);
  }

  async insertVersion(v: TemplateVersion & { createdAt: string }): Promise<void> {
    if (!this.templates.has(v.templateId)) throw new Error('FOREIGN KEY constraint failed');
    if (this.versions.has(v.id) || (await this.hasVersion(v.templateId, v.version))) {
      throw new Error('UNIQUE constraint failed: workflow_template_version');
    }
    const unique = (values: unknown[]) => new Set(values).size === values.length;
    if (!unique(v.steps.map((s) => s.key)) || !unique(v.steps.map((s) => s.position))) {
      throw new Error('UNIQUE constraint failed: workflow_step_definition');
    }
    const steps = [...v.steps].sort((a, b) => a.position - b.position).map((s) => ({ ...s }));
    this.versions.set(v.id, { ...v, steps });
  }

  async latestVersion(templateId: string): Promise<TemplateVersion | null> {
    const latest = this.versionsOf(templateId)[0];
    return latest ? { id: latest.id, templateId: latest.templateId, version: latest.version, steps: latest.steps.map((s) => ({ ...s })) } : null;
  }
}

type WorkflowRow = { id: string; assetId: string; templateVersionId: string; createdAt: string };
type StepRow = {
  id: string;
  workflowId: string;
  stepDefinitionId: string;
  state: WorkflowStepState;
  notes: string;
  updatedAt: string;
  completedAt: string | null;
};

class InMemoryAssetWorkflows implements AssetWorkflowRepository {
  readonly workflows = new Map<string, WorkflowRow>(); // by assetId
  readonly steps = new Map<string, StepRow>();

  constructor(private readonly templates: InMemoryWorkflowTemplates) {}

  async insert(w: WorkflowRow, steps: NewWorkflowStep[]): Promise<void> {
    if (this.workflows.has(w.assetId)) throw new Error('UNIQUE constraint failed: asset_workflow.asset_id');
    for (const s of steps) {
      if (this.templates.definition(s.stepDefinitionId) === null) throw new Error('FOREIGN KEY constraint failed');
    }
    this.workflows.set(w.assetId, { ...w });
    for (const s of steps) {
      this.steps.set(s.id, {
        id: s.id,
        workflowId: w.id,
        stepDefinitionId: s.stepDefinitionId,
        state: 'not_started',
        notes: '',
        updatedAt: s.updatedAt,
        completedAt: null,
      });
    }
  }

  async getByAsset(assetId: string): Promise<AssetWorkflow | null> {
    const w = this.workflows.get(assetId);
    if (!w) return null;
    const version = this.templates.versions.get(w.templateVersionId)!;
    const template = this.templates.templates.get(version.templateId)!;
    const steps: WorkflowStep[] = [...this.steps.values()]
      .filter((s) => s.workflowId === w.id)
      .map((s) => {
        const { step } = this.templates.definition(s.stepDefinitionId)!;
        return {
          id: s.id,
          key: step.key,
          name: step.name,
          position: step.position,
          mandatory: step.mandatory,
          state: s.state,
          notes: s.notes,
          updatedAt: s.updatedAt,
          completedAt: s.completedAt,
        };
      })
      .sort((a, b) => a.position - b.position);
    return {
      id: w.id,
      assetId: w.assetId,
      templateId: template.id,
      templateName: template.name,
      templateVersion: version.version,
      createdAt: w.createdAt,
      progress: progressOf(steps),
      steps,
    };
  }

  async getStepContext(stepId: string): Promise<StepContext | null> {
    const s = this.steps.get(stepId);
    if (!s) return null;
    const w = [...this.workflows.values()].find((r) => r.id === s.workflowId)!;
    const { step } = this.templates.definition(s.stepDefinitionId)!;
    return { stepId: s.id, assetId: w.assetId, mandatory: step.mandatory, state: s.state };
  }

  async updateStep(
    stepId: string,
    patch: { state?: WorkflowStepState; notes?: string; completedAt?: string | null; updatedAt: string },
  ): Promise<void> {
    const row = this.steps.get(stepId);
    if (!row) return;
    const next = { ...row, ...definedOnly(patch) };
    // Mirrors the check constraint of the database.
    if ((next.state === 'done') !== (next.completedAt !== null)) {
      throw new Error('CHECK constraint failed: asset_workflow_step_completed_check');
    }
    this.steps.set(stepId, next);
  }

  async remove(assetId: string): Promise<boolean> {
    const w = this.workflows.get(assetId);
    if (!w) return false;
    for (const s of [...this.steps.values()]) if (s.workflowId === w.id) this.steps.delete(s.id);
    this.workflows.delete(assetId);
    return true;
  }

  /** Progress of the asset's workflow, or null when it has none. */
  progressOfAsset(assetId: string): WorkflowProgress | null {
    const w = this.workflows.get(assetId);
    if (!w) return null;
    return progressOf(
      [...this.steps.values()]
        .filter((s) => s.workflowId === w.id)
        .map((s) => ({ mandatory: this.templates.definition(s.stepDefinitionId)!.step.mandatory, state: s.state })),
    );
  }
}

/** `done` = mandatory steps in state `done`, `total` = mandatory steps. */
function progressOf(steps: readonly { mandatory: boolean; state: WorkflowStepState }[]): WorkflowProgress {
  const mandatory = steps.filter((s) => s.mandatory);
  return { done: mandatory.filter((s) => s.state === 'done').length, total: mandatory.length };
}

const byNameThenId = <T extends { name: string; id: string }>(a: T, b: T) =>
  a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function definedOnly<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Assignments keyed by `projectId|assetId`; shared so project and asset lists can derive their counts. */
class AssignmentRows extends Map<string, ProjectAssignment> {}
const assignmentKey = (k: AssignmentKey) => `${k.projectId}|${k.assetId}`;

const completeFilesOf = (files: InMemoryFiles, assetId: string): FileRecord[] =>
  [...files.records.values()].filter((f) => f.assetId === assetId && f.status === 'complete');

/** Each tag must be on the asset or on one of its complete files; different tags may have different owners. */
function carriesTags(tags: InMemoryTags, files: InMemoryFiles, assetId: string, names: string[]): boolean {
  if (names.length === 0) return true;
  const fileIds = new Set(completeFilesOf(files, assetId).map((f) => f.id));
  return names.every(
    (name) =>
      tags.assetAssignments.some((a) => a.assetId === assetId && a.name === name) ||
      tags.fileAssignments.some((a) => fileIds.has(a.fileId) && a.name === name),
  );
}

/**
 * One entry per requested tag, in request order, saying whether one of the assets or one of their
 * complete files carries it. Unknown tags are left out.
 */
function matchedTagsOver(tags: InMemoryTags, files: InMemoryFiles, assetIds: string[], names: string[]): MatchedTag[] {
  const owners = new Set(assetIds);
  const fileIds = new Set(assetIds.flatMap((id) => completeFilesOf(files, id).map((f) => f.id)));
  return [...new Set(names)].flatMap((name) => {
    const known = tags.tags.get(name);
    if (known === undefined) return [];
    return [
      {
        name,
        displayName: known.displayName,
        onAsset: tags.assetAssignments.some((t) => owners.has(t.assetId) && t.name === name),
        onFiles: tags.fileAssignments.some((t) => fileIds.has(t.fileId) && t.name === name),
      },
    ];
  });
}

class InMemoryProjects implements ProjectRepository {
  readonly rows = new Map<string, Project>();

  constructor(
    private readonly links: AssignmentRows,
    private readonly files: InMemoryFiles,
    private readonly tags: InMemoryTags,
  ) {}

  async insert(project: Project): Promise<void> {
    this.rows.set(project.id, project);
  }

  async get(id: string): Promise<Project | null> {
    return this.rows.get(id) ?? null;
  }

  async update(
    id: string,
    patch: Partial<Pick<Project, 'name' | 'description' | 'status'>> & { updatedAt: string },
  ): Promise<Project | null> {
    const row = this.rows.get(id);
    if (!row) return null;
    const next = { ...row, ...definedOnly(patch) };
    this.rows.set(id, next);
    return next;
  }

  private memberIds(projectId: string): string[] {
    return [...this.links.values()].filter((l) => l.projectId === projectId).map((l) => l.assetId);
  }

  async list(q: ProjectQuery): Promise<ProjectList> {
    const text = q.query === undefined ? undefined : foldSearchWord(q.query);
    const names = q.tagNames ?? [];
    /** The members that carry every requested tag (all members without tags). */
    const matchingMembers = (projectId: string) =>
      this.memberIds(projectId).filter((id) => carriesTags(this.tags, this.files, id, names));
    const sorted = [...this.rows.values()]
      .filter((p) => q.status === undefined || p.status === q.status)
      .filter((p) => text === undefined || [p.name, p.description].some((t) => foldSearchWord(t).includes(text)))
      .filter((p) => names.length === 0 || matchingMembers(p.id).length > 0)
      .sort(byNameThenId);
    const items = sorted.slice(q.offset, q.offset + q.limit).map((p) => {
      const members = this.memberIds(p.id);
      return {
        ...p,
        assetCount: members.length,
        imageCount: members.flatMap((id) => completeFilesOf(this.files, id)).filter((f) => f.kind === 'image').length,
        ...(names.length > 0 && { matchedTags: matchedTagsOver(this.tags, this.files, matchingMembers(p.id), names) }),
      };
    });
    return { items, total: sorted.length };
  }
}

const startsWithToken = (tokens: string[], word: string) => tokens.some((t) => t.startsWith(word));

/** All words of a text, without the 16-word cap of a search query. */
const allWords = textWords;

/** 1 when every query word is a prefix of some name word, else 0 (the fake's two-bucket ranking). */
const nameMatches = (a: Asset, words: string[]) => {
  if (words.length === 0) return 0;
  const tokens = allWords(a.name).map(foldSearchWord);
  return words.every((w) => startsWithToken(tokens, w)) ? 1 : 0;
};

class InMemoryAssets implements AssetRepository {
  readonly rows = new Map<string, Asset>();

  constructor(
    private readonly links: AssignmentRows,
    private readonly files: InMemoryFiles,
    private readonly workflows: InMemoryAssetWorkflows,
    private readonly covers: CoverChoices,
    private readonly tags: InMemoryTags,
  ) {}

  private coverOf(assetId: string): AssetCover {
    const chosen = this.covers.get(assetId);
    if (chosen !== undefined) return { coverFileId: chosen, coverIsChosen: true };
    const files = [...this.files.records.values()].filter((f) => f.assetId === assetId);
    return { coverFileId: automaticCover(files), coverIsChosen: false };
  }

  async getCover(assetId: string): Promise<AssetCover | null> {
    return this.rows.has(assetId) ? this.coverOf(assetId) : null;
  }

  async setCover(assetId: string, fileId: string | null, updatedAt: string): Promise<void> {
    const row = this.rows.get(assetId);
    if (!row) return;
    if (fileId === null) this.covers.delete(assetId);
    else this.covers.set(assetId, fileId);
    this.rows.set(assetId, { ...row, updatedAt });
  }

  async insert(asset: Asset): Promise<void> {
    this.rows.set(asset.id, asset);
  }

  async get(id: string): Promise<Asset | null> {
    return this.rows.get(id) ?? null;
  }

  async update(
    id: string,
    patch: Partial<Pick<Asset, 'name' | 'description' | 'typeId' | 'status'>> & { updatedAt: string },
  ): Promise<Asset | null> {
    const row = this.rows.get(id);
    if (!row) return null;
    const next = { ...row, ...definedOnly(patch) };
    this.rows.set(id, next);
    return next;
  }

  private completeFiles(assetId: string): FileRecord[] {
    return completeFilesOf(this.files, assetId);
  }

  /** Folded word tokens per searchable field: name, description, tags and complete file names. */
  private searchFields(a: Asset): string[][] {
    const files = this.completeFiles(a.id);
    const fileIds = new Set(files.map((f) => f.id));
    const texts = [
      a.name,
      a.description,
      ...this.tags.assetAssignments.filter((t) => t.assetId === a.id).map((t) => t.name),
      ...this.tags.fileAssignments.filter((t) => fileIds.has(t.fileId)).map((t) => t.name),
      ...files.map((f) => f.originalName),
    ];
    return texts.map((t) => allWords(t).map(foldSearchWord));
  }

  async list(q: AssetQuery): Promise<AssetList> {
    const words = (q.query === undefined ? [] : searchWords(q.query)).map(foldSearchWord);
    const matching = [...this.rows.values()]
      .filter((a) => q.typeId === undefined || a.typeId === q.typeId)
      .filter((a) => q.status === undefined || a.status === q.status)
      .filter((a) => q.projectId === undefined || this.links.has(assignmentKey({ projectId: q.projectId, assetId: a.id })))
      .filter((a) => carriesTags(this.tags, this.files, a.id, q.tagNames ?? []))
      .filter((a) => q.fileRole === undefined || this.completeFiles(a.id).some((f) => f.role === q.fileRole))
      .filter((a) => q.fileKind === undefined || this.completeFiles(a.id).some((f) => f.kind === q.fileKind))
      .filter((a) => words.every((w) => this.searchFields(a).some((tokens) => startsWithToken(tokens, w))))
      .sort((a, b) => nameMatches(b, words) - nameMatches(a, words) || byNameThenId(a, b));
    const items = matching.slice(q.offset, q.offset + q.limit).map((a) => {
      const coverFileId = this.coverOf(a.id).coverFileId;
      return {
        ...a,
        projectCount: [...this.links.values()].filter((l) => l.assetId === a.id).length,
        fileCount: [...this.files.records.values()].filter((f) => f.assetId === a.id).length,
        workflowProgress: this.workflows.progressOfAsset(a.id),
        coverFileId,
        tags: this.tags.forAsset(a.id),
        coverTags: coverFileId === null ? [] : this.tags.forFile(coverFileId),
        ...(q.tagNames !== undefined && q.tagNames.length > 0 && { matchedTags: matchedTagsOver(this.tags, this.files, [a.id], q.tagNames) }),
      };
    });
    return { items, total: matching.length };
  }
}

class InMemoryProjectAssets implements ProjectAssetRepository {
  constructor(
    private readonly links: AssignmentRows,
    private readonly projects: InMemoryProjects,
    private readonly assets: InMemoryAssets,
  ) {}

  async insert(a: ProjectAssignment): Promise<void> {
    if (this.links.has(assignmentKey(a))) throw new Error('UNIQUE constraint failed: project_asset');
    this.links.set(assignmentKey(a), a);
  }

  async get(key: AssignmentKey): Promise<ProjectAssignment | null> {
    return this.links.get(assignmentKey(key)) ?? null;
  }

  async update(
    key: AssignmentKey,
    patch: Partial<Pick<ProjectAssignment, 'priority' | 'intendedUse' | 'approvalStatus' | 'notes'>> & {
      updatedAt: string;
    },
  ): Promise<ProjectAssignment | null> {
    const row = this.links.get(assignmentKey(key));
    if (!row) return null;
    const next = { ...row, ...definedOnly(patch) };
    this.links.set(assignmentKey(key), next);
    return next;
  }

  async remove(key: AssignmentKey): Promise<boolean> {
    return this.links.delete(assignmentKey(key));
  }

  async listByAsset(assetId: string): Promise<AssetAssignment[]> {
    return [...this.links.values()]
      .filter((l) => l.assetId === assetId)
      .map((l) => ({ ...l, project: this.projects.rows.get(l.projectId)! }))
      .sort((a, b) => byNameThenId(a.project, b.project));
  }

  async listByProject(projectId: string, q: Page): Promise<ProjectMemberList> {
    const members = [...this.links.values()]
      .filter((l) => l.projectId === projectId)
      .map((l) => ({ ...l, asset: this.assets.rows.get(l.assetId)! }))
      .sort((a, b) => byNameThenId(a.asset, b.asset));
    return { items: members.slice(q.offset, q.offset + q.limit), total: members.length };
  }
}

class InMemoryRelations implements AssetRelationRepository {
  readonly rows: AssetRelation[] = [];

  constructor(private readonly assets: InMemoryAssets) {}

  private find(k: RelationKey): number {
    return this.rows.findIndex(
      (r) => r.fromAssetId === k.fromAssetId && r.toAssetId === k.toAssetId && r.kind === k.kind,
    );
  }

  async insert(r: AssetRelation): Promise<boolean> {
    if (this.find(r) >= 0) return false;
    this.rows.push(r);
    return true;
  }

  async remove(key: RelationKey): Promise<boolean> {
    const idx = this.find(key);
    if (idx < 0) return false;
    this.rows.splice(idx, 1);
    return true;
  }

  async listForAsset(assetId: string): Promise<AssetRelationView[]> {
    const view = (r: AssetRelation, direction: 'outgoing' | 'incoming', otherId: string): AssetRelationView => ({
      ...r,
      direction,
      other: this.assets.rows.get(otherId)!,
    });
    const order = (a: AssetRelationView, b: AssetRelationView) =>
      (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) || byNameThenId(a.other, b.other);
    const outgoing = this.rows.filter((r) => r.fromAssetId === assetId).map((r) => view(r, 'outgoing', r.toAssetId));
    const incoming = this.rows.filter((r) => r.toAssetId === assetId).map((r) => view(r, 'incoming', r.fromAssetId));
    return [...outgoing.sort(order), ...incoming.sort(order)];
  }
}

export class InMemoryDatabase implements WorkspaceDatabase {
  readonly meta = new InMemoryMeta();
  readonly storages = new InMemoryStorages();
  private readonly covers = new CoverChoices();
  readonly tags = new InMemoryTags();
  private readonly proposals = new ProposalRows();
  readonly files = new InMemoryFiles(this.covers, this.tags, this.proposals);
  readonly fileMoves = new InMemoryFileMoves(this.files);
  readonly assetTypes = new InMemoryAssetTypes();
  private readonly links = new AssignmentRows();
  readonly projects = new InMemoryProjects(this.links, this.files, this.tags);
  readonly workflowTemplates = new InMemoryWorkflowTemplates();
  readonly assetWorkflows = new InMemoryAssetWorkflows(this.workflowTemplates);
  readonly assets = new InMemoryAssets(this.links, this.files, this.assetWorkflows, this.covers, this.tags);
  readonly projectAssets = new InMemoryProjectAssets(this.links, this.projects, this.assets);
  readonly relations = new InMemoryRelations(this.assets);
  readonly jobs = new InMemoryJobRepository(
    (fileId) => this.files.records.get(fileId)?.originalName ?? null,
    (fileId) => {
      const rec = this.files.records.get(fileId);
      return rec === undefined ? 'unknown' : rec.deletedAt === null ? 'live' : 'trashed';
    },
  );
  readonly analyses = new InMemoryAnalyses(this.files, this.tags, this.proposals);
  readonly analysisTargets = new InMemoryAnalysisTargets(this.files, this.assets, this.analyses, this.jobs);
  closed = false;

  constructor() {
    this.tags.files = this.files;
    this.tags.proposals = this.proposals;
    this.files.assetName = (assetId) => this.assets.rows.get(assetId)?.name ?? null;
    this.files.hasMove = (fileId) => this.fileMoves.rows.has(fileId);
    // The purge transaction: tags, analysis, proposal and jobs of the file go with it.
    this.files.onPurge = (fileId) => {
      const tags = this.tags.fileAssignments;
      tags.splice(0, tags.length, ...tags.filter((a) => a.fileId !== fileId));
      this.analyses.rows.delete(fileId);
      this.proposals.delete(fileId);
      const jobs = this.jobs.rows;
      jobs.splice(0, jobs.length, ...jobs.filter((j) => j.fileId !== fileId));
    };
  }

  /** How often `ensureDerivedData` ran. */
  derivedDataCalls = 0;

  /** Recomputes every file's kind from its original name; the fake has no search index to rebuild. */
  async ensureDerivedData(): Promise<void> {
    this.derivedDataCalls++;
    for (const [id, rec] of this.files.records) {
      const kind = fileKind(rec.originalName);
      if (kind !== rec.kind) this.files.records.set(id, { ...rec, kind });
    }
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export class InMemoryRegistry implements WorkspaceRegistry {
  private readonly entries = new Map<string, WorkspaceSummary>();

  async list(): Promise<WorkspaceSummary[]> {
    return [...this.entries.values()];
  }

  async get(id: string): Promise<WorkspaceSummary | null> {
    return this.entries.get(id) ?? null;
  }

  async upsert(entry: WorkspaceSummary): Promise<void> {
    this.entries.set(entry.id, entry);
  }

  async remove(id: string): Promise<void> {
    this.entries.delete(id);
  }
}

/** Maps absolute source paths to file contents. */
export class FakeSourceFiles extends Map<string, Buffer> implements SourceFiles {
  /** Paths that exist but cannot be read (e.g. directories). */
  readonly unreadable = new Set<string>();
  /** Every path `open` was called with. */
  readonly opened: string[] = [];

  async open(absolutePath: string): Promise<{ name: string; stream: Readable }> {
    this.opened.push(absolutePath);
    const data = this.get(absolutePath);
    if (!data || this.unreadable.has(absolutePath)) throw new SourceNotReadableError();
    const name = absolutePath.split(/[\\/]/).pop() ?? absolutePath;
    return { name, stream: Readable.from([data]) };
  }
}

/** One entry of a fake archive; `declaredSize` defaults to the content's length. */
export interface FakeArchiveEntry {
  name: string;
  content?: Buffer | string;
  declaredSize?: number;
  isDirectory?: boolean;
  isSymlink?: boolean;
  isUnsupported?: boolean;
  /** `openEntry` rejects for this entry. */
  failOpen?: boolean;
  /** The entry's stream yields a part of the content, then errors. */
  failStream?: boolean;
}

/**
 * Maps absolute archive paths to `'not-zip'` or a list of entries; an unknown path is not
 * readable. Ignores `maxEntries`, so the caller's own count check is what a test sees.
 */
export class FakeArchives extends Map<string, 'not-zip' | FakeArchiveEntry[]> implements ArchiveReader {
  /** Every `open` call. */
  readonly opened: { path: string; maxEntries: number }[] = [];
  /** Every index `openEntry` was called with, across archives. */
  readonly openedEntries: number[] = [];
  closed = 0;

  async open(absolutePath: string, limits: { maxEntries: number }): Promise<OpenArchive> {
    this.opened.push({ path: absolutePath, maxEntries: limits.maxEntries });
    const archive = this.get(absolutePath);
    if (archive === undefined) throw new SourceNotReadableError();
    if (archive === 'not-zip') throw new ArchiveNotReadableError();
    const bytes = (e: FakeArchiveEntry) => Buffer.from(e.content ?? '');
    return {
      entries: archive.map((e) => ({
        name: e.name,
        uncompressedSize: e.declaredSize ?? bytes(e).length,
        isDirectory: e.isDirectory ?? false,
        isSymlink: e.isSymlink ?? false,
        isUnsupported: e.isUnsupported ?? false,
      })),
      openEntry: async (index) => {
        this.openedEntries.push(index);
        const entry = archive[index]!;
        if (entry.failOpen) throw new Error(`EIO: i/o error, read '${absolutePath}'`);
        const data = bytes(entry);
        if (!entry.failStream) return Readable.from([data]);
        return Readable.from(
          (async function* () {
            yield data.subarray(0, 1);
            throw new Error(`invalid stored block lengths in ${entry.name}`);
          })(),
        );
      },
      close: async () => {
        this.closed += 1;
      },
    };
  }
}

/** Records its calls; `result` is returned, or `failure` is thrown when set. */
export class FakeImageProbe implements ImageProbe {
  readonly calls: string[] = [];
  result: { width: number; height: number } | null = { width: 640, height: 480 };
  failure: Error | null = null;

  async measure(absolutePath: string): Promise<{ width: number; height: number } | null> {
    this.calls.push(absolutePath);
    if (this.failure) throw this.failure;
    return this.result;
  }
}

/** Answers `jpeg` from `script` (one entry per call, the last entry repeating); records every path. */
export class FakeModelImageSource implements ModelImageSource {
  readonly calls: string[] = [];
  /** Per call: bytes or null to return, an error to throw, or a function of the path. */
  script: (Uint8Array | null | Error | ((absolutePath: string) => Uint8Array | null))[] = [new Uint8Array([0xff, 0xd8, 0xff])];

  async jpeg(absolutePath: string): Promise<Uint8Array | null> {
    const call = this.calls.push(absolutePath) - 1;
    const step = this.script[Math.min(call, this.script.length - 1)]!;
    if (step instanceof Error) throw step;
    return typeof step === 'function' ? step(absolutePath) : step;
  }
}

type DescribeRequest = { image: Uint8Array; prompt: string; model: string; signal: AbortSignal };
type VisionRequest = { image: Uint8Array; prompt: string; schema: unknown; model: string; signal: AbortSignal };

/** Resolves with `answer`, or with what `respond` returns when set; records every request. */
export class FakeVisionProvider implements VisionProvider {
  readonly calls: Omit<VisionRequest, 'signal'>[] = [];
  answer: unknown = { tags: ['Red Car', 'metal', 'front view', 'photorealistic'] };
  respond: ((r: VisionRequest) => Promise<unknown>) | null = null;

  async analyzeImage(r: VisionRequest): Promise<unknown> {
    this.calls.push({ image: r.image, prompt: r.prompt, schema: r.schema, model: r.model });
    return this.respond === null ? this.answer : this.respond(r);
  }

  /** Every `describeImage` request. */
  readonly describeCalls: Omit<DescribeRequest, 'signal'>[] = [];
  description = '  A red sports car seen from the front.  ';
  describe: ((r: DescribeRequest) => Promise<string>) | null = null;

  async describeImage(r: DescribeRequest): Promise<string> {
    this.describeCalls.push({ image: r.image, prompt: r.prompt, model: r.model });
    return this.describe === null ? this.description : this.describe(r);
  }

  models: { name: string; vision: boolean | null }[] = [{ name: 'mock-vision', vision: true }];

  async listModels(_signal: AbortSignal): Promise<{ name: string; vision: boolean | null }[]> {
    return this.models.map((m) => ({ ...m }));
  }
}

/** Trashes files through `trashFiles` with a control that cancels nothing; throws the first item error. */
export async function trashForTest(s: WorkspaceSession, fileIds: readonly string[]): Promise<void> {
  const items = await trashFiles(s, { wake() {}, async cancel() {} }, fileIds);
  for (const item of items) if (item.error) throw item.error;
}

export function createFakeHost(): {
  host: WorkspaceHost;
  probe: FakeImageProbe;
  storages: Map<string, InMemoryStorage>;
  databases: Map<string, InMemoryDatabase>;
  sources: FakeSourceFiles;
  archives: FakeArchives;
  trash: { paths: string[]; failNext: boolean };
} {
  const trash = { paths: [] as string[], failNext: false };
  const storages = new Map<string, InMemoryStorage>();
  const databases = new Map<string, InMemoryDatabase>();
  const sources = new FakeSourceFiles();
  const archives = new FakeArchives();
  const probe = new FakeImageProbe();
  const host: WorkspaceHost = {
    registry: new InMemoryRegistry(),
    sources,
    archives,
    imageProbe: probe,
    createStorage(rootPath) {
      let storage = storages.get(rootPath);
      if (!storage) {
        storage = new InMemoryStorage();
        storages.set(rootPath, storage);
      }
      return storage;
    },
    async openDatabase(workspaceId) {
      let db = databases.get(workspaceId);
      if (!db) {
        db = new InMemoryDatabase();
        databases.set(workspaceId, db);
      }
      db.closed = false;
      return db;
    },
    async deleteDatabase(workspaceId) {
      databases.delete(workspaceId);
    },
    async moveToTrash(rootPath) {
      if (trash.failNext) {
        trash.failNext = false;
        throw new Error(`EBUSY: resource busy, rmdir '${rootPath}'`);
      }
      storages.delete(rootPath);
      trash.paths.push(rootPath);
    },
    newId: () => crypto.randomUUID(),
    now: () => new Date(),
  };
  return { host, probe, storages, databases, sources, archives, trash };
}
