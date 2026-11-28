import type {
  AssetAssignment,
  Project,
  ProjectAssignment,
  ProjectList,
  ProjectMemberList,
  ProjectStatus,
} from '@assetforge/contracts';
import type { Page } from './page.js';

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
