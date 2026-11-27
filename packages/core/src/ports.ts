import type { Readable } from 'node:stream';
import type { VideoFormat } from './media-types.js';
import type {
  AnalysisPreview,
  AnalysisTarget,
  Asset,
  AssetList,
  AssetAssignment,
  AssetRelation,
  AssetRelationView,
  AssetSource,
  AssetStatus,
  AssetType,
  FileList,
  FileOrigin,
  FileRecord,
  FileRole,
  FileKind,
  FileScope,
  ImportStatus,
  JobErrorCode,
  JobResult,
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
  Generation,
  GenerationKind,
  GenerationParameters,
  ImageModel,
  ListImageModelsResult,
  ProviderKind,
  PromptDetail,
  PromptSummary,
  PromptVariable,
  PromptVersion,
} from '@assetforge/contracts';
import type { Job, JobOutcome, NewJob } from './jobs.js';

export interface Storage {
  isReachable(): Promise<boolean>; // root's parent volume/dir is accessible
  isEmptyOrMissing(): Promise<boolean>; // root does not exist or has no entries
  ensureLayout(): Promise<void>; // creates root and LAYOUT_DIRS
  readText(relPath: string): Promise<string | null>; // null if missing
  writeText(relPath: string, text: string): Promise<void>; // atomic: temp file + rename
  /** `onProgress` receives the cumulative number of bytes as chunks are written. */
  writeStream(
    relPath: string,
    source: Readable,
    options?: { onProgress?(bytesWritten: number): void },
  ): Promise<{ sizeBytes: number; sha256: string }>;
  hashFile(relPath: string): Promise<string>; // lowercase hex SHA-256
  move(from: string, to: string): Promise<void>; // rejects if `to` exists
  exists(relPath: string): Promise<boolean>;
  remove(relPath: string): Promise<void>; // no-op if missing
  list(relDir: string): Promise<string[]>; // entry names; [] if dir missing
  /** Absolute path of a path inside the storage root; validated like every other operation. Never sent to the renderer. */
  absolutePath(relativePath: string): Promise<string>;
  /** Free bytes of the volume holding the storage root; null when unknown. */
  freeBytes(): Promise<number | null>;
}

/**
 * Why a remote file could not be fetched; each maps to exactly one job error code (`download_<failure>`, and
 * `challenge`, a browser check such as `cf-mitigated: challenge`, to `download_browser_check`).
 */
export type RemoteFileFailure =
  | 'challenge'
  | 'unreachable'
  | 'unavailable'
  | 'throttled'
  | 'blocked'
  | 'not_found'
  | 'rejected'
  | 'address_refused'
  | 'too_large';

/** The typed failure of a `RemoteFileSource`. Its message is the failure kind only, never a URL or an address. */
export class RemoteFileError extends Error {
  constructor(
    readonly failure: RemoteFileFailure,
    /** For `throttled`: how long the server asked to wait; null when it did not say. */
    readonly retryAfterMs: number | null = null,
    options?: { cause?: unknown; status?: number },
  ) {
    super(`Remote file failure: ${failure}`, options?.cause === undefined ? undefined : { cause: options.cause });
    this.status = options?.status ?? null;
    this.name = new.target.name;
  }

  /** The HTTP status behind the failure; null when no answer caused it or the source did not say. */
  readonly status: number | null;
}

/** An opened remote file: the response headers are in, the body is `stream`. */
export interface RemoteFile {
  /** Fails with RemoteFileError('too_large') past the size limit and ('unreachable') on a stall or a lost connection. */
  stream: Readable;
  /** The address after redirects; used only to name the file. */
  finalUrl: string;
  /** Lower case, without parameters. */
  contentType: string | null;
  contentLength: number | null;
  /** Raw file name from Content-Disposition. */
  dispositionName: string | null;
}

/** Headers a site profile's login adds to one request; never logged, stored or sent over IPC. */
export interface RemoteRequestHeaders {
  cookie?: string;
  userAgent?: string;
}

export interface RemoteOpenOptions {
  /** Asked once per hop with that hop's URL; null sends the request as without options. */
  headersFor?: (url: string) => Promise<RemoteRequestHeaders | null>;
}

/** The network behind the URL import. */
export interface RemoteFileSource {
  /** Rejects with RemoteFileError, or with the abort reason once `signal` aborts. */
  open(url: string, signal: AbortSignal, options?: RemoteOpenOptions): Promise<RemoteFile>;
}

/** The logins of the site profiles, as the download path sees them. */
export interface SiteAccess {
  /** The site of the profile; null when the profile does not exist. */
  siteOf(profileId: string): Promise<string | null>;
  /** Null unless the URL belongs to the profile's site. */
  headersFor(profileId: string, url: string): Promise<RemoteRequestHeaders | null>;
  /**
   * Opens a site download through the profile's own browser session: every hop on the profile's site goes out with
   * the session's cookies and network stack, the first hop off the site and the rest go through the plain
   * `RemoteFileSource`. Asks `options.headersFor` once per hop like `RemoteFileSource.open`. Rejects with
   * RemoteFileError, or with the abort reason once `signal` aborts. Absent where no browser session exists.
   */
  open?(profileId: string, url: string, signal: AbortSignal, options: RemoteOpenOptions): Promise<RemoteFile>;
}

export type PageLoadResult =
  /**
   * Absolute or relative strings as found, per query name. `baseUrl` is the document's base URL as the page
   * reported it (after redirects and any `<base href>`); the crawl resolves against it only when it is a URL of the
   * profile's site, so any string may come here.
   */
  | { ok: true; results: Record<string, string[]>; baseUrl: string }
  /**
   * `no_match`: the document finished loading but the waited-for query matched nothing in time; `timeout`: it did
   * not finish loading in time; `failed`: a network or other failure, also a cancel.
   */
  | { ok: false; reason: 'no_match' | 'timeout' | 'failed' }
  /** A navigation off the site was refused; `host` is its lower-case host, empty when unknown. */
  | { ok: false; reason: 'left_site'; host: string }
  /** The main frame answered `status` (400 or more) and the waited-for query did not match. */
  | { ok: false; reason: 'http_error'; status: number }
  | { ok: false; reason: 'invalid_xpath'; query: string };

/** Reads pages of a site in a browser session of its profile. */
export interface PageLoader {
  /** Loads `url`, waits until the query named `waitFor` matches, then answers every query. */
  load(url: string, r: { queries: Record<string, string>; waitFor: string; signal: AbortSignal }): Promise<PageLoadResult>;
}

export interface SourceFiles {
  /** Rejects with SourceNotReadableError; `sizeBytes` is the file's size when known. */
  open(absolutePath: string): Promise<{ name: string; stream: Readable; sizeBytes?: number }>;
}

export interface ArchiveEntry {
  /** The entry's path as stored in the archive. */
  name: string;
  uncompressedSize: number;
  isDirectory: boolean;
  isSymlink: boolean;
  /** Encrypted, or a compression method other than stored/deflate. */
  isUnsupported: boolean;
}

export interface OpenArchive {
  entries: readonly ArchiveEntry[];
  /** A stream of the entry's content that fails when it does not yield exactly `uncompressedSize` bytes. */
  openEntry(index: number): Promise<Readable>;
  close(): Promise<void>;
}

export interface ArchiveReader {
  /**
   * Rejects with SourceNotReadableError (missing, not a regular file, not readable),
   * ArchiveNotReadableError (not a ZIP) or ArchiveTooLargeError (more than `maxEntries` entries, decided before reading the directory).
   */
  open(absolutePath: string, limits: { maxEntries: number }): Promise<OpenArchive>;
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
    /** A download's origin, written in the same transaction with created_at = importedAt; it marks the row as a download. */
    origin?: { id: string; url: string };
  }): Promise<void>;
  /** Deletes a pending row (its origins cascade). False when the row is missing or not pending. */
  deletePending(id: string): Promise<boolean>;
  /** Ids of pending rows that carry an origin. */
  listPendingDownloadIds(): Promise<string[]>;
  markComplete(id: string, r: { sizeBytes: number; sha256: string; width: number | null; height: number | null }): Promise<void>; // rejects with NotFoundError for an unknown id
  /**
   * Stores the pixel size, and the duration when `durationMs` is given (a video); rejects with NotFoundError for an
   * unknown id.
   */
  setDimensions(id: string, size: { width: number; height: number; durationMs?: number | null }): Promise<FileRecord>;
  markFailed(id: string, error: string): Promise<void>; // rejects with NotFoundError for an unknown id
  /** Complete files outside the trash with this checksum, oldest import first, then id. */
  findCompleteBySha256(sha256: string): Promise<FileRecord[]>;
  listByStatus(status: ImportStatus): Promise<FileRecord[]>;
  get(id: string): Promise<FileRecord | null>;
  /** Rejects with NotFoundError for an unknown id. Clears the chosen cover of any other asset than `placement.assetId` that uses this file. */
  setPlacement(id: string, placement: FilePlacement): Promise<FileRecord>;
  list(q: FileQuery): Promise<FileList>; // newest importedAt first
  /**
   * One transaction: deletes the file row and every row that references it, only for a row that is
   * in the trash or has status `failed`. False otherwise and for an unknown id. Rejects with
   * InvalidOperationError and deletes nothing while the file has an open `file_move` row or a running
   * `image.generate` job (`RUNNING_GENERATION_MESSAGE`). For a
   * trashed file the same transaction writes a purge tombstone (`file_purge`).
   */
  purge(id: string): Promise<boolean>;
  /** The ids of purged trashed files whose tombstone is still there, ascending. */
  listPurgedIds(): Promise<string[]>;
  /** Deletes the purge tombstone of `id`; no-op without one. */
  forgetPurge(id: string): Promise<void>;
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
  /** Only these files, within the scope and every other filter. */
  ids?: readonly string[];
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
  /**
   * The tag with this normalised name: its display name, the assets that carry it themselves, the files not in the
   * trash and the prompts that carry it. Null without a tag row.
   */
  usage(name: string): Promise<{ displayName: string; assets: number; files: number; prompts: number } | null>;
  /**
   * One transaction. `from` and `name` are normalised. Throws NotFoundError('Tag does not exist') without a tag `from`.
   * from === name: sets the display name. Otherwise, no tag `name`: renames the row (name and display name).
   * Otherwise a merge: throws InvalidOperationError('A tag with this name already exists') unless `merge`; moves every
   * link of `from` to `name` (an owner carrying both keeps one link, manual when either was manual, with the earlier
   * createdAt), sets the target's display name and deletes the source row. Prompt links move the same way (prompt tags
   * have no origin) and leave the prompt's updated_at alone.
   * Except for from === name: rewrites waiting proposals that hold `from` and reindexes the assets affected.
   */
  rename(r: { from: string; name: string; displayName: string; merge: boolean }): Promise<{ merged: boolean }>;
}

/** Source URLs of assets; an asset carries a URL at most once (compared as stored, i.e. as normalised `href`). */
export interface AssetSourceRepository {
  listByAsset(assetId: string): Promise<AssetSource[]>; // by createdAt, then id
  get(id: string): Promise<(AssetSource & { assetId: string }) | null>;
  countByAsset(assetId: string): Promise<number>;
  /** False, writing nothing, when the asset already has this URL. */
  insert(row: { id: string; assetId: string; url: string; createdAt: string }): Promise<boolean>;
  /** False when no row has this id. */
  remove(id: string): Promise<boolean>;
}

/**
 * Web addresses a file was downloaded from; a file carries a URL at most once and at most MAX_FILE_ORIGINS.
 * The rows go with the file when it is purged; trash and restore keep them.
 */
export interface FileOriginRepository {
  listByFile(fileId: string): Promise<FileOrigin[]>; // by createdAt, then id
  get(id: string): Promise<(FileOrigin & { fileId: string }) | null>;
  /** The oldest complete file (trash included) that carries this URL; null when none. */
  findCompleteFileByUrl(url: string): Promise<string | null>;
  /** Of `urls`, those carried by a complete file (trash included). */
  knownUrls(urls: readonly string[]): Promise<Set<string>>;
  /** False, writing nothing, when the file already has this URL or already carries MAX_FILE_ORIGINS. */
  insert(row: { id: string; fileId: string; url: string; createdAt: string }): Promise<boolean>;
}

/** The persistent job queue of a workspace. Every transition is guarded by the status it starts from. */
export interface JobRepository {
  /** One transaction. Inserts each job as `queued`, attempt 0; a job whose dedupe key is held by an active job (or by an earlier job of the same call) is skipped. Returns the inserted ids. */
  enqueue(r: { jobs: readonly NewJob[]; now: string }): Promise<string[]>;
  get(id: string): Promise<Job | null>;
  listByStatus(status: JobStatus): Promise<Job[]>; // oldest created_at first, then id
  /**
   * Oldest job (created_at, id) of the class and one of `types` that is `queued`, or `retry_wait` with run_after <= now,
   * whose lane is not in `excludeLanes` (`null` in it excludes the jobs without a lane). Atomically sets `running`,
   * attempt + 1, started_at = now, clears run_after and the error.
   */
  claimNext(r: {
    resourceClass: ResourceClass;
    types: readonly string[];
    now: string;
    excludeLanes?: readonly (string | null)[];
  }): Promise<Job | null>;
  /** Earliest run_after of `retry_wait` jobs of these types whose lane is not in `excludeLanes`; null when there is none. */
  nextRunAfter(types: readonly string[], excludeLanes?: readonly (string | null)[]): Promise<string | null>;
  /**
   * running → succeeded | failed | cancelled, finished_at = now, message from JOB_ERROR_MESSAGES. False when the row is not `running`.
   * `settled` runs inside the transaction, once and only when the row changed; a throw rolls the end back.
   */
  finish(
    id: string,
    r: { status: 'succeeded' | 'failed' | 'cancelled'; errorCode: JobErrorCode | null; now: string; settled?: () => void },
  ): Promise<boolean>;
  /** running → retry_wait with run_after and the error. False when the row is not `running`. */
  scheduleRetry(id: string, r: { errorCode: JobErrorCode; runAfter: string; now: string }): Promise<boolean>;
  /**
   * Sets file_id and result of a running job; `fileId` null clears it (a `filtered` download keeps no file).
   * False when the row is not `running` or the file does not exist.
   */
  setOutcome(id: string, r: { fileId: string | null; result: JobResult | null; now: string }): Promise<boolean>;
  /**
   * queued | retry_wait jobs of these types in this lane (`null` is the jobs without one) whose run_after is null or
   * earlier than `until`: status retry_wait, run_after = until; attempt and error untouched. Returns how many.
   */
  holdLane(r: { types: readonly string[]; lane: string | null; until: string; now: string }): Promise<number>;
  /** running → queued, attempt − 1 (not below 0), started_at cleared. False when the row is not `running`. */
  release(id: string, now: string): Promise<boolean>;
  /**
   * queued | retry_wait | waiting_remote → cancelled, for one job or for all. Returns how many. `settled` runs
   * inside the transaction with each cancelled job; a throw rolls every cancel back.
   */
  cancelPending(r: { id?: string; now: string; settled?: (job: Job) => void }): Promise<number>;
  /**
   * One transaction over the jobs of one file: when one of them is `running` and of a type in `refuseRunning`,
   * changes nothing and answers `refused: true`; otherwise every queued, retry_wait or waiting_remote job of the
   * file becomes cancelled like `cancelPending` (with `settled` per job, a throw rolls every cancel back).
   */
  cancelPendingOfFile(r: {
    fileId: string;
    refuseRunning: readonly string[];
    now: string;
    settled?: (job: Job) => void;
  }): Promise<{ refused: boolean; cancelled: number }>;
  /**
   * failed | cancelled → queued with attempt 0, error, run_after, started_at and finished_at cleared; for one job or for all,
   * newest created_at first, skipping a job whose dedupe key is held by an active job and a job of one of `excludeTypes`.
   * Clears `result`, and for `FILE_DOWNLOAD_JOB` jobs `file_id`. Returns how many.
   */
  retry(r: { id?: string; now: string; excludeTypes?: readonly string[] }): Promise<number>;
  /** Deletes every succeeded, failed or cancelled job. Returns how many. */
  clearFinished(): Promise<number>;
  counts(): Promise<Record<JobStatus, number>>;
  /**
   * Newest created_at first, then id descending; with `lane` only the jobs of that lane. `fileName` is the file's
   * original name, `providerId` the lane, `providerName` and `model` come from `analysisJobFields` of the payload,
   * `url` and `host` from `downloadJobFields`, `result` from the stored column. A `FILE_DOWNLOAD_JOB` answers
   * `providerId`, `providerName` and `model` null. `ids` narrows the list to those jobs within the other filters.
   */
  list(q: {
    limit: number;
    offset: number;
    status?: JobStatus;
    lane?: string;
    ids?: readonly string[];
  }): Promise<{ items: JobView[]; total: number }>;
  /** Jobs of this type in `queued` or `retry_wait`, counted per lane; lanes without such a job are left out. */
  waitingByLane(type: string): Promise<{ lane: string | null; waiting: number }[]>;
  /** The payload of the newest job (created_at, then id) of this type and lane in any status; null when there is none. */
  latestPayloadOfLane(type: string, lane: string | null): Promise<unknown | null>;
  /** Jobs of this type and lane in `queued`, `retry_wait`, `running` or `waiting_remote`. */
  countActiveInLane(type: string, lane: string): Promise<number>;
  /**
   * One transaction. Every job of this type and `fromLane` in `queued` or `retry_wait` gets `toLane`, the payload
   * `rewrite` answers, status `queued`, attempt 0, and run_after and the error cleared. Returns how many.
   */
  rerouteWaiting(r: { type: string; fromLane: string | null; toLane: string; rewrite: (payload: unknown) => unknown; now: string }): Promise<number>;
  /**
   * One transaction. Every active job of this type without a lane gets `lane` and the payload `rewrite` answers;
   * a row for which `rewrite` answers null is left as it is. Status and attempt stay. Returns how many changed.
   */
  assignLane(r: { type: string; lane: string; rewrite: (payload: unknown) => unknown | null; now: string }): Promise<number>;
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
  /** Name of the analysis prompt used, as it was then; null for analyses from before analysis prompts. */
  promptName: string | null;
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
  /** Already cleaned, at most 50. */
  tags: { name: string; displayName: string }[];
  /** Name of the analysis prompt used, as it was then; null for proposals from before analysis prompts. */
  promptName: string | null;
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
    /** Recorded on the analysis row; not part of the fingerprint. */
    promptName: string | null;
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
   * exactly `tags` as `apply` does, writes the analysis row from the proposal's fingerprint and prompt name with
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

/** A file a generation read or wrote, as it was then. */
export interface GenerationFileRef {
  fileId: string;
  sha256: string;
  originalName: string;
}

export interface NewGeneration {
  id: string;
  kind: GenerationKind;
  providerId: string;
  /** A copy of the provider name at start. */
  providerName: string;
  providerKind: ProviderKind;
  /** Null for an upscale. */
  model: string | null;
  /** The fully resolved prompt; null for an upscale. */
  prompt: string | null;
  parameters: GenerationParameters;
  /** The library prompt version it was started from; null for an upscale or a free prompt. */
  promptRef: GenerationPromptRef | null;
  createdAt: string;
}

/** A library prompt version as a generation records it; title and number are copies taken at start. */
export interface GenerationPromptRef {
  versionId: string;
  title: string;
  versionNumber: number;
  /** The values by the version's spelling of each variable. */
  variables: Record<string, string>;
}

/** A generation with its input and output files; `jobStatus` is the status of its current job row, null when it is gone. */
export type GenerationRow = Generation;

/**
 * The generations of a workspace. Every transition is guarded by the status it starts from; a purged file
 * reads as `fileId: null` in `inputs` and `outputs`.
 */
export interface GenerationRepository {
  /** One transaction: the generation as `pending`, its input row and the job; `job_id` is the job's id. */
  create(r: { generation: NewGeneration; input: GenerationFileRef; job: NewJob }): Promise<void>;
  get(id: string): Promise<GenerationRow | null>;
  /** The generation whose current job is this one. */
  byJob(jobId: string): Promise<GenerationRow | null>;
  /** The generation that wrote this file. */
  madeBy(fileId: string): Promise<GenerationRow | null>;
  /** The generations that read this file, newest (created_at, then id) first. */
  resultsOf(fileId: string, limit: number): Promise<GenerationRow[]>;
  /** The 1-based rank of this edit among the edits of its input file by (created_at, id); 0 when it is unknown or no edit. */
  editRank(id: string): Promise<number>;
  /** One transaction guarded on `pending`: the output row and `succeeded` with finished_at = now. False otherwise. */
  succeed(r: { id: string; output: GenerationFileRef; now: string }): Promise<boolean>;
  /**
   * Synchronous, for `JobHandler.settled`; changes only a `pending` row and answers whether it did. `failed` sets the
   * code, `cancelled` clears it; a `succeeded` outcome on a still pending row becomes failed `internal_error`.
   */
  settle(r: { id: string; outcome: JobOutcome; now: string }): boolean;
  /**
   * One transaction guarded on `failed` | `cancelled`: inserts the job, sets `pending`, clears the error and finished_at
   * and replaces job_id. False and nothing written otherwise.
   */
  requeue(r: { id: string; job: NewJob; now: string }): Promise<boolean>;
  /** Deletes a `failed` or `cancelled` generation; false otherwise. */
  remove(id: string): Promise<boolean>;
  /** Distinct prompts of edit generations, newest use first. */
  recentPrompts(limit: number): Promise<string[]>;
  /**
   * Every `pending` generation whose job row is gone or finished takes that job's outcome as `settle` does,
   * or failed `provider_outcome_unknown` when the row is gone. Returns how many changed.
   */
  reconcile(now: string): Promise<number>;
}

/** A prompt version as core writes it; `variables` are the items core derived from the content. */
export interface NewPromptVersion {
  id: string;
  content: string;
  variables: PromptVariable[];
}

/**
 * The prompt library of a workspace. Titles are unique by `titleKey` (the lower-cased title); versions are numbered
 * 1, 2, 3 … per prompt and never changed. Prompt tags are always manual.
 */
export interface PromptRepository {
  /** One transaction: the prompt and version 1. False, writing nothing, when `titleKey` is taken. */
  create(r: { id: string; title: string; titleKey: string; description: string; version: NewPromptVersion; now: string }): Promise<boolean>;
  /** Sets title, description and updated_at. */
  update(r: { id: string; title: string; titleKey: string; description: string; now: string }): Promise<'ok' | 'missing' | 'title_taken'>;
  get(id: string): Promise<PromptDetail | null>;
  /** A version with the id and current title of its prompt. */
  getVersion(versionId: string): Promise<{ promptId: string; title: string; version: PromptVersion } | null>;
  /** One transaction guarded on `baseVersionId` being the highest number: inserts number + 1, sets updated_at. */
  addVersion(r: { promptId: string; baseVersionId: string; version: NewPromptVersion; now: string }): Promise<'ok' | 'missing' | 'stale'>;
  /** Deletes the prompt with versions and tag links; generations keep their copies and lose the version id. */
  remove(id: string): Promise<boolean>;
  /**
   * `words` are already folded with `foldSearchWord`, `tagNames` already normalised. Every word is a literal substring of
   * the folded title, description, current content or a tag's display name; every tag name is on the prompt. Order
   * updated_at desc, then id asc.
   */
  list(q: { words: readonly string[]; tagNames: readonly string[]; offset: number; limit: number }): Promise<{ items: PromptSummary[]; total: number }>;
  /**
   * One transaction: inserts the tag row if its name is missing, then the link; sets updated_at. A link that exists is a
   * no-op ('ok'); 'limit' and nothing written when the prompt already carries `max` tags.
   */
  addTag(r: { promptId: string; name: string; displayName: string; newId: string; now: string; max: number }): Promise<'ok' | 'missing' | 'limit'>;
  /** Deletes the link and sets updated_at; a tag the prompt does not carry is a no-op ('ok'). */
  removeTag(r: { promptId: string; name: string; now: string }): Promise<'ok' | 'missing'>;
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
  assetSources: AssetSourceRepository;
  fileOrigins: FileOriginRepository;
  jobs: JobRepository;
  analyses: FileAnalysisRepository;
  analysisTargets: AnalysisTargetReader;
  generations: GenerationRepository;
  prompts: PromptRepository;
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

/** The displayed size (after rotation) and length of a video; `durationMs` is null when unknown. */
export interface VideoInfo {
  width: number;
  height: number;
  durationMs: number | null;
}

/** Reads size and length of a video file; null when they cannot be determined. Implemented outside core. */
export interface VideoProbe {
  measure(absolutePath: string, format: VideoFormat): Promise<VideoInfo | null>;
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

/** An image as it is sent to an image provider; held in main-process memory, never sent over IPC. */
export interface ImageInput {
  data: Uint8Array;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
}

/**
 * An image provider (edit and upscale). Each method rejects with a `JobError` on provider failure, or with
 * the signal's reason when `signal` aborts. Implemented outside core.
 */
export interface ImageProvider {
  listEditModels(signal: AbortSignal): Promise<ImageModel[]>;
  editImage(r: {
    image: ImageInput;
    model: string;
    prompt: string;
    aspectRatio: string | null;
    resolution: string | null;
    safeMode: boolean;
    signal: AbortSignal;
  }): Promise<{ stream: Readable; mimeType: string }>;
  upscaleImage(r: { image: ImageInput; scale: 2 | 4; signal: AbortSignal }): Promise<{ stream: Readable; mimeType: string }>;
}

/** The `venice` provider entries as use cases see them. Implemented outside core. */
export interface ImageProviderDirectory {
  /**
   * A given id: that entry, else NotFoundError, or InvalidOperationError when it is not a `venice` entry.
   * Absent: the image entry used last, else the first, else null.
   */
  resolve(id: string | undefined): { id: string; name: string } | null;
  exists(id: string): boolean;
  adapter(id: string): ImageProvider | null;
  /** The entry's edit models: cached, else loaded within `LIST_MODELS_TIMEOUT_MS`. */
  models(id: string, signal: AbortSignal): Promise<ListImageModelsResult>;
  /** Best effort. */
  markUsed(id: string): void;
}

/** Reads the image a generation sends. Implemented outside core. */
export interface GenerationImageSource {
  /**
   * The original when it is JPEG, PNG or WebP and at most `IMAGE_INPUT_MAX_BYTES`, else the lossless rendition
   * when it is at most that size, else null.
   */
  read(
    file: { absolutePath: string; mimeType: string; sha256: string; sizeBytes: number },
    signal: AbortSignal,
  ): Promise<ImageInput | null>;
}

export interface WorkspaceHost {
  registry: WorkspaceRegistry;
  sources: SourceFiles;
  archives: ArchiveReader;
  imageProbe: ImageProbe;
  videoProbe: VideoProbe;
  createStorage(rootPath: string): Storage;
  openDatabase(workspaceId: string): Promise<WorkspaceDatabase>; // creates the file and applies migrations
  deleteDatabase(workspaceId: string): Promise<void>; // removes the local database; no-op if missing
  moveToTrash(rootPath: string): Promise<void>; // recoverable removal of a workspace folder
  newId(): string;
  now(): Date;
}
