import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type {
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
import { fileKind, isOpenable, isPreviewable } from '../src/media-types.js';
import { LAYOUT_DIRS } from '../src/paths.js';
import { foldSearchWord, searchWords, textWords } from '../src/search.js';
import {
  InvalidOperationError,
  NotFoundError,
  SourceNotReadableError,
  StorageUnreachableError,
  ValidationFailedError,
} from '../src/errors.js';
import type {
  AssetCover,
  AssetQuery,
  AssetRelationRepository,
  AssetRepository,
  AssignmentKey,
  AssetTypeRepository,
  AssetWorkflowRepository,
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
  WorkspaceDatabase,
  WorkspaceHost,
  WorkspaceMeta,
  WorkspaceMetaRepository,
  WorkspaceRegistry,
} from '../src/ports.js';

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
    for (const a of [...this.assetAssignments, ...this.fileAssignments]) used.set(a.name, (used.get(a.name) ?? 0) + 1);
    return [...used]
      .filter(([name]) => name.startsWith(q.prefix))
      .sort(([an, ac], [bn, bc]) => bc - ac || (an < bn ? -1 : an > bn ? 1 : 0))
      .slice(0, q.limit)
      .map(([name]) => ({ name, displayName: this.tags.get(name)!.displayName }));
  }

  private ensureTag(r: { name: string; displayName: string; newId: string }): void {
    if (!this.tags.has(r.name)) this.tags.set(r.name, { id: r.newId, displayName: r.displayName });
  }

  async addToAsset(r: { assetId: string; name: string; displayName: string; origin: TagOrigin; newId: string; now: string }): Promise<void> {
    this.ensureTag(r);
    if (!this.assetAssignments.some((a) => a.assetId === r.assetId && a.name === r.name && a.origin === r.origin)) {
      this.assetAssignments.push({ assetId: r.assetId, name: r.name, origin: r.origin });
    }
  }

  async removeFromAsset(r: { assetId: string; name: string; origin: TagOrigin }): Promise<void> {
    const i = this.assetAssignments.findIndex((a) => a.assetId === r.assetId && a.name === r.name && a.origin === r.origin);
    if (i >= 0) this.assetAssignments.splice(i, 1);
  }

  async addToFile(r: { fileId: string; name: string; displayName: string; origin: TagOrigin; newId: string; now: string }): Promise<void> {
    this.ensureTag(r);
    if (!this.fileAssignments.some((a) => a.fileId === r.fileId && a.name === r.name && a.origin === r.origin)) {
      this.fileAssignments.push({ fileId: r.fileId, name: r.name, origin: r.origin });
    }
  }

  async removeFromFile(r: { fileId: string; name: string; origin: TagOrigin }): Promise<void> {
    const i = this.fileAssignments.findIndex((a) => a.fileId === r.fileId && a.name === r.name && a.origin === r.origin);
    if (i >= 0) this.fileAssignments.splice(i, 1);
  }

  /** Set by the database; the batches check and return file records. */
  files: InMemoryFiles | null = null;

  /** Throws for an unknown or incomplete file before anything is written, like one transaction. */
  private async requireCompleteFiles(fileIds: readonly string[]): Promise<void> {
    for (const id of fileIds) {
      const rec = this.files!.records.get(id);
      if (!rec) throw new NotFoundError(`File ${id} does not exist`);
      if (rec.status !== 'complete') throw new ValidationFailedError(`File ${id} is not completely imported`);
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

  async removeFromFiles(r: { fileIds: readonly string[]; name: string; origin: TagOrigin }): Promise<FileRecord[]> {
    await this.requireCompleteFiles(r.fileIds);
    for (const fileId of r.fileIds) await this.removeFromFile({ ...r, fileId });
    return this.recordsOf(r.fileIds);
  }

  async listForAsset(assetId: string): Promise<TagAssignment[]> {
    return this.forAsset(assetId);
  }

  forAsset(assetId: string): TagAssignment[] {
    return InMemoryTags.sorted(this.assetAssignments.filter((a) => a.assetId === assetId), this.tags);
  }

  forFile(fileId: string): TagAssignment[] {
    return InMemoryTags.sorted(this.fileAssignments.filter((a) => a.fileId === fileId), this.tags);
  }
}

class InMemoryFiles implements FileRepository {
  /** Stored without tags; every method that returns a record attaches the current file tags. */
  readonly records = new Map<string, FileRecord>();

  constructor(
    private readonly covers: CoverChoices,
    private readonly tags: InMemoryTags,
  ) {}

  private withTags(rec: FileRecord): FileRecord {
    return { ...rec, tags: this.tags.forFile(rec.id) };
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
      tags: [],
    });
  }

  async markComplete(id: string, r: { sizeBytes: number; sha256: string }): Promise<void> {
    const rec = this.require(id);
    this.records.set(id, { ...rec, status: 'complete', sizeBytes: r.sizeBytes, sha256: r.sha256, error: null });
  }

  async markFailed(id: string, error: string): Promise<void> {
    const rec = this.require(id);
    this.records.set(id, { ...rec, status: 'failed', error });
  }

  async findCompleteBySha256(sha256: string): Promise<FileRecord[]> {
    return [...this.records.values()].filter((r) => r.status === 'complete' && r.sha256 === sha256).map((r) => this.withTags(r));
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
    const words = (q.query === undefined ? [] : searchWords(q.query)).map(foldSearchWord);
    const tagsOf = (fileId: string) => this.tags.fileAssignments.filter((a) => a.fileId === fileId).map((a) => a.name);
    // Plan decision 1/2: a word is a substring of the folded name or a word prefix of a tag name.
    const matchesWord = (r: FileRecord, w: string) =>
      foldSearchWord(r.originalName).includes(w) ||
      tagsOf(r.id).some((name) => startsWithToken(textWords(name).map(foldSearchWord), w));
    const sorted = [...this.records.values()]
      .filter((r) => scope.kind === 'all' || r.assetId === (scope.kind === 'asset' ? scope.assetId : null))
      .filter((r) => q.role === undefined || r.role === q.role)
      .filter((r) => q.kind === undefined || r.kind === q.kind)
      .filter((r) => (q.tagNames ?? []).every((name) => tagsOf(r.id).includes(name)))
      .filter((r) => words.every((w) => matchesWord(r, w)))
      .sort((a, b) => (a.importedAt < b.importedAt ? 1 : a.importedAt > b.importedAt ? -1 : 0) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    return { items: sorted.slice(q.offset, q.offset + q.limit).map((r) => this.withTags(r)), total: sorted.length };
  }

  private require(id: string): FileRecord {
    const rec = this.records.get(id);
    if (!rec) throw new NotFoundError(`Unknown file id: ${id}`);
    return rec;
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
    const next = await this.files.setPlacement(fileId, {
      relativePath: move.targetRelativePath,
      assetId: move.targetAssetId,
      role: move.targetRole,
    });
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
  readonly files = new InMemoryFiles(this.covers, this.tags);
  readonly fileMoves = new InMemoryFileMoves(this.files);
  readonly assetTypes = new InMemoryAssetTypes();
  private readonly links = new AssignmentRows();
  readonly projects = new InMemoryProjects(this.links, this.files, this.tags);
  readonly workflowTemplates = new InMemoryWorkflowTemplates();
  readonly assetWorkflows = new InMemoryAssetWorkflows(this.workflowTemplates);
  readonly assets = new InMemoryAssets(this.links, this.files, this.assetWorkflows, this.covers, this.tags);
  readonly projectAssets = new InMemoryProjectAssets(this.links, this.projects, this.assets);
  readonly relations = new InMemoryRelations(this.assets);
  closed = false;

  constructor() {
    this.tags.files = this.files;
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
    if (!data || this.unreadable.has(absolutePath)) throw new SourceNotReadableError(`Cannot read source: ${absolutePath}`);
    const name = absolutePath.split(/[\\/]/).pop() ?? absolutePath;
    return { name, stream: Readable.from([data]) };
  }
}

export function createFakeHost(): {
  host: WorkspaceHost;
  storages: Map<string, InMemoryStorage>;
  databases: Map<string, InMemoryDatabase>;
  sources: FakeSourceFiles;
  trash: { paths: string[]; failNext: boolean };
} {
  const trash = { paths: [] as string[], failNext: false };
  const storages = new Map<string, InMemoryStorage>();
  const databases = new Map<string, InMemoryDatabase>();
  const sources = new FakeSourceFiles();
  const host: WorkspaceHost = {
    registry: new InMemoryRegistry(),
    sources,
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
  return { host, storages, databases, sources, trash };
}
