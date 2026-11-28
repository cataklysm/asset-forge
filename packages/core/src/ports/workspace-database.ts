import type { AnalysisTargetReader, FileAnalysisRepository } from './analysis-repositories.js';
import type {
  AssetRelationRepository,
  AssetRepository,
  AssetSourceRepository,
  AssetTypeRepository,
} from './asset-repositories.js';
import type { FileMoveRepository, FileOriginRepository, FileRepository } from './file-repositories.js';
import type { GenerationRepository } from './generation-repository.js';
import type { JobRepository } from './job-repository.js';
import type { ProjectAssetRepository, ProjectRepository } from './project-repositories.js';
import type { PromptRepository } from './prompt-repository.js';
import type { TagRepository } from './tag-repository.js';
import type { AssetWorkflowRepository, WorkflowTemplateRepository } from './workflow-repositories.js';

// The database of one workspace: every repository, and the two rows that describe the workspace itself.

/** The storage row that every file row refers to by id. */
export interface StorageRef {
  /** The storage id stored on every file row. */
  id: string;
  /** The only kind so far: the workspace's own root folder. */
  kind: 'workspace_root';
  /** When the row was written. */
  createdAt: string;
}

/** The storage rows of a workspace. */
export interface StorageRepository {
  /**
   * The primary storage.
   *
   * @returns its row; null before one was written
   */
  getPrimary(): Promise<StorageRef | null>;
  /**
   * Returns the existing primary storage, or inserts and returns one built from `storage`.
   *
   * @param storage the id and creation time of a new row
   * @returns the primary storage
   */
  ensurePrimary(storage: { id: string; createdAt: string }): Promise<StorageRef>;
}

/** The row that describes the workspace in its own database. */
export interface WorkspaceMeta {
  /** The workspace id. */
  id: string;
  /** `WORKSPACE_FORMAT_VERSION` at creation. */
  formatVersion: number;
  /** The workspace name. */
  name: string;
  /** When the workspace was created. */
  createdAt: string;
}

/** The single description row of the workspace. */
export interface WorkspaceMetaRepository {
  /**
   * The description row.
   *
   * @returns the row; null before it was written
   */
  get(): Promise<WorkspaceMeta | null>;
  /**
   * Writes the description row; rejects with InvalidOperationError when a row exists.
   *
   * @param meta the row
   */
  init(meta: WorkspaceMeta): Promise<void>;
}

/** The open database of one workspace: one repository per subject. Implemented outside core. */
export interface WorkspaceDatabase {
  /** The description of the workspace. */
  meta: WorkspaceMetaRepository;
  /** The storage rows. */
  storages: StorageRepository;
  /** The file rows. */
  files: FileRepository;
  /** The journal of file moves. */
  fileMoves: FileMoveRepository;
  /** The asset types. */
  assetTypes: AssetTypeRepository;
  /** The projects. */
  projects: ProjectRepository;
  /** The assets. */
  assets: AssetRepository;
  /** The assignments of assets to projects. */
  projectAssets: ProjectAssetRepository;
  /** The relations between assets. */
  relations: AssetRelationRepository;
  /** The workflow templates and their versions. */
  workflowTemplates: WorkflowTemplateRepository;
  /** The workflow instances of assets. */
  assetWorkflows: AssetWorkflowRepository;
  /** The tags of assets and files. */
  tags: TagRepository;
  /** The source URLs of assets. */
  assetSources: AssetSourceRepository;
  /** The download origins of files. */
  fileOrigins: FileOriginRepository;
  /** The job queue. */
  jobs: JobRepository;
  /** The analysis records and tag proposals. */
  analyses: FileAnalysisRepository;
  /** The enumeration of analysis targets. */
  analysisTargets: AnalysisTargetReader;
  /** The generations. */
  generations: GenerationRepository;
  /** The prompt library. */
  prompts: PromptRepository;
  /**
   * Recomputes derived data (file kinds, the search index) unless the stored stamp is current;
   * the stamp is written last, so an interrupted run is redone on the next open.
   */
  ensureDerivedData(): Promise<void>;
  /** Closes the database. */
  close(): Promise<void>;
}
