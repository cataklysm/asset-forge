import type {
  AssetAssignment,
  Project,
  ProjectAssignment,
  ProjectList,
  ProjectMemberList,
  ProjectStatus,
} from '@assetforge/contracts';
import type { Page } from './page.js';

// The projects of a workspace and their n:m assignments to assets with project-specific data.

/** The projects of a workspace. */
export interface ProjectRepository {
  /**
   * Inserts a new project.
   *
   * @param project the row
   */
  insert(project: Project): Promise<void>;
  /**
   * One project.
   *
   * @param id the project
   * @returns the project; null for an unknown id
   */
  get(id: string): Promise<Project | null>;
  /**
   * Writes exactly the given fields.
   *
   * @param id the project
   * @param patch the changed fields and the new updated_at
   * @returns the updated project; null for an unknown id
   */
  update(
    id: string,
    patch: Partial<Pick<Project, 'name' | 'description' | 'status'>> & { updatedAt: string },
  ): Promise<Project | null>;
  /**
   * One page of projects by name (case-insensitive), then id.
   *
   * @param filter the filters and the page
   * @returns the page and the total
   */
  list(filter: ProjectQuery): Promise<ProjectList>;
}

/** What a project list asks for: the filters and the page. */
export interface ProjectQuery extends Page {
  /** Free text, trimmed; matches a folded substring of the name or the description. Absent when empty. */
  query?: string;
  /** Only projects in this status. */
  status?: ProjectStatus;
  /**
   * Normalised, distinct tag names; one member asset must carry all of them, each on the asset or
   * on one of its complete files. With tags, `matchedTags` is aggregated over exactly those members.
   */
  tagNames?: string[];
}

/** What identifies an assignment: the project and the asset. */
export interface AssignmentKey {
  /** The project. */
  projectId: string;
  /** The asset. */
  assetId: string;
}

/** The assignments of assets to projects; removing one never touches the asset or its files. */
export interface ProjectAssetRepository {
  /**
   * Inserts an assignment.
   *
   * @param assignment the row with its project-specific data
   */
  insert(assignment: ProjectAssignment): Promise<void>;
  /**
   * One assignment.
   *
   * @param key the project and the asset
   * @returns the assignment; null when there is none
   */
  get(key: AssignmentKey): Promise<ProjectAssignment | null>;
  /**
   * Writes exactly the given fields of the project-specific data.
   *
   * @param key the project and the asset
   * @param patch the changed fields and the new updated_at
   * @returns the updated assignment; null when there is none
   */
  update(
    key: AssignmentKey,
    patch: Partial<Pick<ProjectAssignment, 'priority' | 'intendedUse' | 'approvalStatus' | 'notes'>> & {
      updatedAt: string;
    },
  ): Promise<ProjectAssignment | null>;
  /**
   * Deletes an assignment.
   *
   * @param key the project and the asset
   * @returns false if there was none
   */
  remove(key: AssignmentKey): Promise<boolean>;
  /**
   * The projects an asset is assigned to.
   *
   * @param assetId the asset
   * @returns the assignments by project name, then id
   */
  listByAsset(assetId: string): Promise<AssetAssignment[]>;
  /**
   * One page of the assets assigned to a project.
   *
   * @param projectId the project
   * @param page the page
   * @returns the members by asset name, then id, and the total
   */
  listByProject(projectId: string, page: Page): Promise<ProjectMemberList>;
}
