import type { Project, ProjectList, ProjectStatus } from '@assetforge/contracts';
import { NotFoundError } from './errors.js';
import type { ProjectQuery } from './ports/project-repositories.js';
import type { WorkspaceSession } from './session.js';
import { tagName } from './tags.js';

/**
 * Creates an active project.
 *
 * @param session the open workspace
 * @param input the name and the optional description
 * @returns the new project
 */
export async function createProject(
  session: WorkspaceSession,
  input: { name: string; description?: string },
): Promise<Project> {
  const now = session.now().toISOString();
  const project: Project = {
    id: session.newId(),
    name: input.name,
    description: input.description ?? '',
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
  await session.database.projects.insert(project);
  return project;
}

/**
 * Changes the given fields of a project; `updatedAt` moves.
 *
 * @param session the open workspace
 * @param id the project
 * @param patch the fields to change
 * @returns the changed project
 * @throws `NotFoundError` for an unknown project
 */
export async function updateProject(
  session: WorkspaceSession,
  id: string,
  patch: { name?: string; description?: string; status?: ProjectStatus },
): Promise<Project> {
  const updated = await session.database.projects.update(id, { ...patch, updatedAt: session.now().toISOString() });
  if (updated === null) throw new NotFoundError(`Project ${id} does not exist`);
  return updated;
}

/**
 * A project that must exist.
 *
 * @param session the open workspace
 * @param id the project
 * @returns it
 * @throws `NotFoundError` when it does not exist
 */
export async function getProject(session: WorkspaceSession, id: string): Promise<Project> {
  const project = await session.database.projects.get(id);
  if (project === null) throw new NotFoundError(`Project ${id} does not exist`);
  return project;
}

/**
 * One page of projects. Trims the query (dropped when empty) and normalises and de-duplicates the tag names, as
 * `listAssets` does.
 *
 * @param session the open workspace
 * @param projectQuery the filter and the page
 * @returns the page
 */
export async function listProjects(session: WorkspaceSession, projectQuery: ProjectQuery): Promise<ProjectList> {
  const { query, tagNames, ...rest } = projectQuery;
  const text = query?.trim() ?? '';
  const names = tagNames === undefined ? [] : [...new Set(tagNames.map((tag) => tagName(tag).name))];
  return session.database.projects.list({
    ...rest,
    ...(text.length > 0 && { query: text }),
    ...(names.length > 0 && { tagNames: names }),
  });
}
