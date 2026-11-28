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
