import type { Readable } from 'node:stream';
import type {
  AnalysisPreview,
  AnalysisTarget,
  Asset,
  AssetList,
  AssetAssignment,
  AssetRelation,
  AssetRelationView,
  AssetStatus,
  AssetType,
  FileList,
  FileRecord,
  FileRole,
  FileKind,
  FileScope,
  ImportStatus,
  JobErrorCode,
  JobStatus,
  JobView,
  Project,
  ProjectAssignment,
  ProjectList,
  ProjectMemberList,
  ProjectStatus,
  RelationKind,
  TagAssignment,
  TagOrigin,
  TagSuggestion,
  AssetWorkflow,
  WorkflowStepState,
  WorkflowTemplate,
  WorkspaceSummary,
  ResourceClass,
} from '@assetforge/contracts';
import type { Job, NewJob } from './jobs.js';

export interface Storage {
  isReachable(): Promise<boolean>; // root's parent volume/dir is accessible
  isEmptyOrMissing(): Promise<boolean>; // root does not exist or has no entries
  ensureLayout(): Promise<void>; // creates root and LAYOUT_DIRS
  readText(relPath: string): Promise<string | null>; // null if missing
  writeText(relPath: string, text: string): Promise<void>; // atomic: temp file + rename
  writeStream(relPath: string, source: Readable): Promise<{ sizeBytes: number; sha256: string }>;
  hashFile(relPath: string): Promise<string>; // lowercase hex SHA-256
  move(from: string, to: string): Promise<void>; // rejects if `to` exists
  exists(relPath: string): Promise<boolean>;
  remove(relPath: string): Promise<void>; // no-op if missing
  list(relDir: string): Promise<string[]>; // entry names; [] if dir missing
  /** Absolute path of a path inside the storage root; validated like every other operation. Never sent to the renderer. */
  absolutePath(relativePath: string): Promise<string>;
}

export interface SourceFiles {
  open(absolutePath: string): Promise<{ name: string; stream: Readable }>; // rejects with SourceNotReadableError
}

export interface StorageRef {
  id: string;
  kind: 'workspace_root';
  createdAt: string;
}

export interface StorageRepository {
  getPrimary(): Promise<StorageRef | null>;
  /** Returns the existing primary storage, or inserts and returns one built from `r`. */
  ensurePrimary(r: { id: string; createdAt: string }): Promise<StorageRef>;
}

export interface FileRepository {
  insertPending(r: {
    id: string;
    storageId: string;
    originalName: string;
    relativePath: string;
    mimeType: string;
    importedAt: string;
    kind: FileKind;
  }): Promise<void>;
  markComplete(id: string, r: { sizeBytes: number; sha256: string; width: number | null; height: number | null }): Promise<void>; // rejects with NotFoundError for an unknown id
  /** Stores the pixel size; rejects with NotFoundError for an unknown id. */
  setDimensions(id: string, size: { width: number; height: number }): Promise<FileRecord>;
  markFailed(id: string, error: string): Promise<void>; // rejects with NotFoundError for an unknown id
  findCompleteBySha256(sha256: string): Promise<FileRecord[]>;
  listByStatus(status: ImportStatus): Promise<FileRecord[]>;
  get(id: string): Promise<FileRecord | null>;
  /** Rejects with NotFoundError for an unknown id. Clears the chosen cover of any other asset than `placement.assetId` that uses this file. */
  setPlacement(id: string, placement: FilePlacement): Promise<FileRecord>;
  list(q: FileQuery): Promise<FileList>; // newest importedAt first
  /**
   * One transaction: deletes the file row and every row that references it, only for a row that is
   * in the trash or has status `failed`. False otherwise and for an unknown id.
   */
  purge(id: string): Promise<boolean>;
  /** How many files are in the trash. */
  countTrashed(): Promise<number>;
  /** The ids of every file in the trash, newest deletion first. */
  listTrashedIds(): Promise<string[]>;
}

export interface Page {
  limit: number;
  offset: number;
}

export interface FileQuery extends Page {
  scope: FileScope;
  /** Free text; every word must be a substring of the folded file name or a word prefix of one of its tags. Absent when the text has no words. */
  query?: string;
  /** Normalised, distinct tag names; each must be on the file itself. */
  tagNames?: string[];
  role?: FileRole;
  kind?: FileKind;
  /** Only files with (true) or without (false) a waiting tag proposal. */
  hasProposal?: boolean;
}

/** Where a file row points: its path and, unless it is in the inbox, its asset and role. */
export interface FilePlacement {
  relativePath: string;
  assetId: string | null;
  role: FileRole | null;
}

/** What the commit of a move does: place the file, send it to the trash, or bring it back from there. */
export type FileMoveKind = 'relocate' | 'trash' | 'restore';

/** Journal entry of a file move in progress: written before the file moves, removed with the commit. */
export interface FileMove {
  fileId: string;
  kind: FileMoveKind;
  targetRelativePath: string;
  targetAssetId: string | null;
  targetRole: FileRole | null;
  createdAt: string;
}

export interface FileMoveRepository {
  begin(move: FileMove): Promise<void>; // rejects with InvalidOperationError if the file already has a move row
  /**
   * One transaction: copy the target into the file row, clear the chosen cover of any other asset
   * than the target that uses this file, delete the move row. NotFoundError if there is no move row.
   */
  commit(fileId: string): Promise<FileRecord>;
  abort(fileId: string): Promise<void>; // no-op if missing
  list(): Promise<FileMove[]>; // by createdAt, then fileId
}

export interface AssetTypeRepository {
  list(): Promise<AssetType[]>; // by sortOrder, then name
  get(id: string): Promise<AssetType | null>;
  insertMissing(types: AssetType[]): Promise<void>; // skips rows whose key already exists
  /** Sets the default template of the type with `typeKey` unless it already has one; no-op for an unknown key. */
  setDefaultWorkflowTemplateIfUnset(typeKey: string, templateId: string): Promise<void>;
}

export interface StepDefinitionInput {
  id: string;
  position: number;
  key: string;
  name: string;
  mandatory: boolean;
}

export interface TemplateVersion {
  id: string;
  templateId: string;
  version: number;
  steps: StepDefinitionInput[]; // by position
}

/** Templates, versions and step definitions are immutable: there is no update or delete. */
export interface WorkflowTemplateRepository {
  list(): Promise<WorkflowTemplate[]>; // by name; only templates with at least one version
  get(id: string): Promise<WorkflowTemplate | null>; // null also for a template without a version
  findByKey(key: string): Promise<{ id: string } | null>;
  insertTemplate(t: { id: string; key: string; name: string; builtIn: boolean; createdAt: string }): Promise<void>;
  hasVersion(templateId: string, version: number): Promise<boolean>;
  /** One transaction: the version row and all its step definitions. */
  insertVersion(v: TemplateVersion & { createdAt: string }): Promise<void>;
  latestVersion(templateId: string): Promise<TemplateVersion | null>;
}

export interface NewWorkflowStep {
  id: string;
  stepDefinitionId: string;
  updatedAt: string;
}

export interface StepContext {
  stepId: string;
  assetId: string;
  mandatory: boolean;
  state: WorkflowStepState;
}

export interface AssetWorkflowRepository {
  /** One transaction: the workflow row and one step row per entry, state 'not_started', notes ''. */
  insert(
    w: { id: string; assetId: string; templateVersionId: string; createdAt: string },
    steps: NewWorkflowStep[],
  ): Promise<void>;
  getByAsset(assetId: string): Promise<AssetWorkflow | null>;
  getStepContext(stepId: string): Promise<StepContext | null>;
  /** Writes exactly the given fields; `completedAt` is not derived from `state`. An unknown step id is a no-op. */
  updateStep(
    stepId: string,
    patch: { state?: WorkflowStepState; notes?: string; completedAt?: string | null; updatedAt: string },
  ): Promise<void>;
  remove(assetId: string): Promise<boolean>; // false if the asset had none
}

export interface ProjectRepository {
  insert(project: Project): Promise<void>;
  get(id: string): Promise<Project | null>;
  update(
    id: string,
    patch: Partial<Pick<Project, 'name' | 'description' | 'status'>> & { updatedAt: string },
  ): Promise<Project | null>;
  list(q: ProjectQuery): Promise<ProjectList>; // by name (case-insensitive), then id
}

export interface ProjectQuery extends Page {
  /** Free text, trimmed; matches a folded substring of the name or the description. Absent when empty. */
  query?: string;
  status?: ProjectStatus;
  /**
   * Normalised, distinct tag names; one member asset must carry all of them, each on the asset or
   * on one of its complete files. With tags, `matchedTags` is aggregated over exactly those members.
   */
  tagNames?: string[];
}

export interface AssetQuery extends Page {
  typeId?: string;
  status?: AssetStatus;
  projectId?: string;
  /** Free text; the repository matches word prefixes. Absent when the text has no words. */
  query?: string;
  /** Normalised, distinct tag names; each must be carried by the asset or by one of its complete files. */
  tagNames?: string[];
  /** Has at least one complete file with this role. */
  fileRole?: FileRole;
  /** Has at least one complete file of this kind. */
  fileKind?: FileKind;
}

/** Effective cover of an asset: the chosen file, else the automatic one (see `automaticCover`), else null. */
export interface AssetCover {
  coverFileId: string | null;
  coverIsChosen: boolean;
}

export interface AssetRepository {
  insert(asset: Asset): Promise<void>;
  get(id: string): Promise<Asset | null>;
  update(
    id: string,
    patch: Partial<Pick<Asset, 'name' | 'description' | 'typeId' | 'status'>> & { updatedAt: string },
  ): Promise<Asset | null>;
  /** By name (case-insensitive), then id; every item carries its effective `coverFileId`. */
  list(q: AssetQuery): Promise<AssetList>;
  getCover(assetId: string): Promise<AssetCover | null>; // null when the asset does not exist
  /** Stores the chosen cover (`null` returns to the automatic one) without validating it; no-op for an unknown asset. */
  setCover(assetId: string, fileId: string | null, updatedAt: string): Promise<void>;
}

export interface AssignmentKey {
  projectId: string;
  assetId: string;
}

export interface ProjectAssetRepository {
  insert(a: ProjectAssignment): Promise<void>;
  get(key: AssignmentKey): Promise<ProjectAssignment | null>;
  update(
    key: AssignmentKey,
    patch: Partial<Pick<ProjectAssignment, 'priority' | 'intendedUse' | 'approvalStatus' | 'notes'>> & {
      updatedAt: string;
    },
  ): Promise<ProjectAssignment | null>;
  remove(key: AssignmentKey): Promise<boolean>; // false if there was none
  listByAsset(assetId: string): Promise<AssetAssignment[]>; // by project name, then id
  listByProject(projectId: string, q: Page): Promise<ProjectMemberList>; // by asset name, then id
}

export interface RelationKey {
  fromAssetId: string;
  toAssetId: string;
  kind: RelationKind;
}

export interface AssetRelationRepository {
  insert(r: AssetRelation): Promise<boolean>; // false if it already exists
  remove(key: RelationKey): Promise<boolean>;
  listForAsset(assetId: string): Promise<AssetRelationView[]>; // outgoing first, then incoming; each by kind, then other.name
}

/**
 * Tags are keyed by normalised name; `displayName` is kept from the first creation. An owner carries
 * a tag at most once: a manual add replaces an AI assignment of that tag on that owner, an AI add does
 * nothing when the owner already carries the tag, and a removal deletes the assignment whatever its origin.
 */
export interface TagRepository {
  /** Tags with at least one assignment whose name starts with `prefix` (already normalised); most used first, then by name. */
  suggest(q: { prefix: string; limit: number }): Promise<TagSuggestion[]>;
  /** One transaction: inserts the tag if its name is missing, then the assignment, applying the rule above. */
  addToAsset(r: { assetId: string; name: string; displayName: string; origin: TagOrigin; newId: string; now: string }): Promise<void>;
  /** Deletes the assignment whatever its origin; a missing tag or assignment is a no-op. */
  removeFromAsset(r: { assetId: string; name: string }): Promise<void>;
  addToFile(r: { fileId: string; name: string; displayName: string; origin: TagOrigin; newId: string; now: string }): Promise<void>;
  removeFromFile(r: { fileId: string; name: string }): Promise<void>;
  /**
   * One transaction over a batch: throws `NotFoundError` for any unknown file and
   * `ValidationFailedError` for any file that is not complete before it writes anything; then
   * adds the assignment to every file by the rule above, reindexes each distinct
   * asset once and returns the records in request order.
   */
  addToFiles(r: { fileIds: readonly string[]; name: string; displayName: string; origin: TagOrigin; newId: string; now: string }): Promise<FileRecord[]>;
  /** Like `addToFiles`, deleting the assignment whatever its origin; a file without it is left alone. */
  removeFromFiles(r: { fileIds: readonly string[]; name: string }): Promise<FileRecord[]>;
  listForAsset(assetId: string): Promise<TagAssignment[]>; // by name, then origin
}

/** The persistent job queue of a workspace. Every transition is guarded by the status it starts from. */
export interface JobRepository {
  /** One transaction. Inserts each job as `queued`, attempt 0; a job whose dedupe key is held by an active job (or by an earlier job of the same call) is skipped. Returns the inserted ids. */
  enqueue(r: { jobs: readonly NewJob[]; now: string }): Promise<string[]>;
  get(id: string): Promise<Job | null>;
  listByStatus(status: JobStatus): Promise<Job[]>; // oldest created_at first, then id
  /** Oldest job (created_at, id) of the class and one of `types` that is `queued`, or `retry_wait` with run_after <= now. Atomically sets `running`, attempt + 1, started_at = now, clears run_after and the error. */
  claimNext(r: { resourceClass: ResourceClass; types: readonly string[]; now: string }): Promise<Job | null>;
  /** Earliest run_after of `retry_wait` jobs of these types; null when there is none. */
  nextRunAfter(types: readonly string[]): Promise<string | null>;
  /** running → succeeded | failed | cancelled, finished_at = now, message from JOB_ERROR_MESSAGES. False when the row is not `running`. */
  finish(id: string, r: { status: 'succeeded' | 'failed' | 'cancelled'; errorCode: JobErrorCode | null; now: string }): Promise<boolean>;
  /** running → retry_wait with run_after and the error. False when the row is not `running`. */
  scheduleRetry(id: string, r: { errorCode: JobErrorCode; runAfter: string; now: string }): Promise<boolean>;
  /** running → queued, attempt − 1 (not below 0), started_at cleared. False when the row is not `running`. */
  release(id: string, now: string): Promise<boolean>;
  /** queued | retry_wait | waiting_remote → cancelled, for one job or for all. Returns how many. */
  cancelPending(r: { id?: string; now: string }): Promise<number>;
  /** failed | cancelled → queued with attempt 0, error, run_after, started_at and finished_at cleared; for one job or for all, newest created_at first, skipping a job whose dedupe key is held by an active job. Returns how many. */
  retry(r: { id?: string; now: string }): Promise<number>;
  /** Deletes every succeeded, failed or cancelled job. Returns how many. */
  clearFinished(): Promise<number>;
  counts(): Promise<Record<JobStatus, number>>;
  /** Newest created_at first, then id descending. `fileName` is the file's original name. */
  list(q: { limit: number; offset: number; status?: JobStatus }): Promise<{ items: JobView[]; total: number }>;
  /**
   * The active or latest job of this type for the file: the newest active job (created_at, then id)
   * when there is one, otherwise the newest job whatever its status; null when there is none.
   */
  latestForFile(fileId: string, type: string): Promise<Job | null>;
  /** Every job of the file in `queued`, `retry_wait`, `running` or `waiting_remote`. */
  activeForFile(fileId: string): Promise<Job[]>;
}

/** Provenance of the latest analysis of a file: the content that was analysed, by what and when. */
export interface FileAnalysis {
  fileId: string;
  sha256: string;
  provider: string;
  model: string;
  promptVersion: number;
  analysedAt: string;
}

/** What an analysis result depends on besides the file content: equal fingerprints and hash mean "already analysed". */
export interface AnalysisFingerprint {
  provider: string;
  model: string;
  promptVersion: number;
}

/** A tag proposal of an analysis in mode `propose`, waiting for the owner; one per file. */
export interface Proposal extends AnalysisFingerprint {
  fileId: string;
  /** Hash of the content that was analysed. */
  sha256: string;
  /** Already cleaned, at most 20. */
  tags: { name: string; displayName: string }[];
  createdAt: string;
}

export interface FileAnalysisRepository {
  get(fileId: string): Promise<FileAnalysis | null>;
  /**
   * One transaction. Returns false and writes nothing unless the file exists, is complete and has
   * this sha256. Otherwise: deletes every `ai` assignment of the file, inserts an `ai` assignment
   * for each tag the file does not carry manually (creating missing tags), upserts the analysis
   * row, deletes a waiting proposal of the file and reindexes the file's asset.
   */
  apply(r: {
    fileId: string;
    sha256: string;
    tags: readonly { name: string; displayName: string; newId: string }[];
    provider: string;
    model: string;
    promptVersion: number;
    now: string;
  }): Promise<boolean>;
  /**
   * One transaction. Returns false and writes nothing unless the file exists, is complete and has
   * this sha256; otherwise stores the proposal, replacing an older one. Tags and the analysis row stay untouched.
   */
  propose(r: Proposal): Promise<boolean>;
  /** The waiting proposal; `stale` when the file's current sha256 differs from the proposal's. */
  getProposal(fileId: string): Promise<(Proposal & { stale: boolean }) | null>;
  /**
   * One transaction. False when there is no proposal or it is stale (the file is gone, not complete
   * or its sha256 differs from `sha256` / the proposal's; a stale proposal is deleted). Otherwise applies
   * exactly `tags` as `apply` does, writes the analysis row from the proposal's fingerprint with
   * `analysedAt = now`, deletes the proposal and returns true.
   */
  acceptProposal(r: {
    fileId: string;
    sha256: string;
    tags: readonly { name: string; displayName: string; newId: string }[];
    now: string;
  }): Promise<boolean>;
  /** Deletes the proposal; no-op without one. */
  discardProposal(fileId: string): Promise<void>;
}

/** One file of an analysis target. */
export interface AnalysisTargetEntry {
  fileId: string;
  /** Complete, of one of the given MIME types, with a checksum (core's `isAnalysable`). */
  analysable: boolean;
  /** The fingerprint and the file's current sha256 equal its analysis row or its waiting proposal. */
  analysed: boolean;
}

/**
 * Enumerates the files of an analysis target in the main process, so the id set never crosses IPC.
 * `asset`: every file of the asset. `assetFilter`: the files of the matching assets, only those with
 * the filter's `fileRole` / `fileKind` when set; `query` and `tagNames` select assets only.
 */
export interface AnalysisTargetReader {
  /** Keyset page by file id, ascending, after `afterId`; unknown ids of a `files` target are absent. */
  page(r: {
    target: AnalysisTarget;
    fingerprint: AnalysisFingerprint;
    mimeTypes: readonly string[];
    afterId: string | null;
    limit: number;
  }): Promise<AnalysisTargetEntry[]>;
  /**
   * Disjoint counts over the whole target, for `analysis:preview`: `notAnalysable` the files that are
   * not analysable; of the analysable ones `alreadyAnalysed` those analysed with the fingerprint,
   * `alreadyQueued` the rest with an active `vision.analyze_file` job, `analysable` the remainder
   * (what an enqueue without `force` would queue). Unknown ids of a `files` target are not counted.
   */
  count(r: { target: AnalysisTarget; fingerprint: AnalysisFingerprint; mimeTypes: readonly string[] }): Promise<AnalysisPreview>;
}

export interface WorkspaceMeta {
  id: string;
  formatVersion: number;
  name: string;
  createdAt: string;
}

export interface WorkspaceMetaRepository {
  get(): Promise<WorkspaceMeta | null>;
  init(meta: WorkspaceMeta): Promise<void>; // rejects with InvalidOperationError when a row exists
}

export interface WorkspaceDatabase {
  meta: WorkspaceMetaRepository;
  storages: StorageRepository;
  files: FileRepository;
  fileMoves: FileMoveRepository;
  assetTypes: AssetTypeRepository;
  projects: ProjectRepository;
  assets: AssetRepository;
  projectAssets: ProjectAssetRepository;
  relations: AssetRelationRepository;
  workflowTemplates: WorkflowTemplateRepository;
  assetWorkflows: AssetWorkflowRepository;
  tags: TagRepository;
  jobs: JobRepository;
  analyses: FileAnalysisRepository;
  analysisTargets: AnalysisTargetReader;
  /**
   * Recomputes derived data (file kinds, the search index) unless the stored stamp is current;
   * the stamp is written last, so an interrupted run is redone on the next open.
   */
  ensureDerivedData(): Promise<void>;
  close(): Promise<void>;
}

export interface WorkspaceRegistry {
  list(): Promise<WorkspaceSummary[]>;
  get(id: string): Promise<WorkspaceSummary | null>;
  upsert(entry: WorkspaceSummary): Promise<void>; // keyed by id
  remove(id: string): Promise<void>; // no-op if unknown
}

/** Reads the pixel size of an image file; null when it cannot be determined. Implemented outside core. */
export interface ImageProbe {
  measure(absolutePath: string): Promise<{ width: number; height: number } | null>;
}

/**
 * A vision provider; the model is an argument of every call, never bound to the instance. Each
 * method rejects with a `JobError` on provider failure, or with the signal's reason when `signal`
 * aborts. Implemented outside core.
 */
export interface VisionProvider {
  /** Resolves with the model's parsed JSON answer, requested in the format `schema`. */
  analyzeImage(r: { image: Uint8Array; prompt: string; schema: unknown; model: string; signal: AbortSignal }): Promise<unknown>;
  /** Resolves with the model's plain-text answer. */
  describeImage(r: { image: Uint8Array; prompt: string; model: string; signal: AbortSignal }): Promise<string>;
  /** The server's models; `vision` is null when the server does not report capabilities. */
  listModels(signal: AbortSignal): Promise<{ name: string; vision: boolean | null }[]>;
}

/** Renders an image for a vision model. Implemented outside core. */
export interface ModelImageSource {
  /** A JPEG of the image, longest edge at most 1024 px, EXIF-oriented; null when it cannot be produced. */
  jpeg(absolutePath: string): Promise<Uint8Array | null>;
}

export interface WorkspaceHost {
  registry: WorkspaceRegistry;
  sources: SourceFiles;
  imageProbe: ImageProbe;
  createStorage(rootPath: string): Storage;
  openDatabase(workspaceId: string): Promise<WorkspaceDatabase>; // creates the file and applies migrations
  deleteDatabase(workspaceId: string): Promise<void>; // removes the local database; no-op if missing
  moveToTrash(rootPath: string): Promise<void>; // recoverable removal of a workspace folder
  newId(): string;
  now(): Date;
}
