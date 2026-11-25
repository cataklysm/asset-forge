import type { Readable } from 'node:stream';
import type {
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
  Project,
  ProjectAssignment,
  ProjectList,
  ProjectMemberList,
  RelationKind,
  TagAssignment,
  TagOrigin,
  TagSuggestion,
  AssetWorkflow,
  WorkflowStepState,
  WorkflowTemplate,
  WorkspaceSummary,
} from '@assetforge/contracts';

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
  markComplete(id: string, r: { sizeBytes: number; sha256: string }): Promise<void>; // rejects with NotFoundError for an unknown id
  markFailed(id: string, error: string): Promise<void>; // rejects with NotFoundError for an unknown id
  findCompleteBySha256(sha256: string): Promise<FileRecord[]>;
  listByStatus(status: ImportStatus): Promise<FileRecord[]>;
  get(id: string): Promise<FileRecord | null>;
  /** Rejects with NotFoundError for an unknown id. Clears the chosen cover of any other asset than `placement.assetId` that uses this file. */
  setPlacement(id: string, placement: FilePlacement): Promise<FileRecord>;
  list(q: FileQuery): Promise<FileList>; // newest importedAt first
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
}

/** Where a file row points: its path and, unless it is in the inbox, its asset and role. */
export interface FilePlacement {
  relativePath: string;
  assetId: string | null;
  role: FileRole | null;
}

/** Journal entry of a file move in progress: written before the file moves, removed with the commit. */
export interface FileMove {
  fileId: string;
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
  list(q: Page): Promise<ProjectList>; // by name (case-insensitive), then id
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
 * Tags are keyed by normalised name; `displayName` is kept from the first creation. An assignment is
 * identified by owner, tag and origin, so a manual and an AI assignment of one tag coexist.
 */
export interface TagRepository {
  /** Tags with at least one assignment whose name starts with `prefix` (already normalised); most used first, then by name. */
  suggest(q: { prefix: string; limit: number }): Promise<TagSuggestion[]>;
  /** One transaction: inserts the tag if its name is missing, then the assignment; an existing assignment is left alone. */
  addToAsset(r: { assetId: string; name: string; displayName: string; origin: TagOrigin; newId: string; now: string }): Promise<void>;
  /** Deletes the one assignment of that origin; a missing tag or assignment is a no-op. */
  removeFromAsset(r: { assetId: string; name: string; origin: TagOrigin }): Promise<void>;
  addToFile(r: { fileId: string; name: string; displayName: string; origin: TagOrigin; newId: string; now: string }): Promise<void>;
  removeFromFile(r: { fileId: string; name: string; origin: TagOrigin }): Promise<void>;
  listForAsset(assetId: string): Promise<TagAssignment[]>; // by name, then origin
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

export interface WorkspaceHost {
  registry: WorkspaceRegistry;
  sources: SourceFiles;
  createStorage(rootPath: string): Storage;
  openDatabase(workspaceId: string): Promise<WorkspaceDatabase>; // creates the file and applies migrations
  deleteDatabase(workspaceId: string): Promise<void>; // removes the local database; no-op if missing
  moveToTrash(rootPath: string): Promise<void>; // recoverable removal of a workspace folder
  newId(): string;
  now(): Date;
}
