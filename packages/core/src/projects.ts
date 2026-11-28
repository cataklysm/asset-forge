import type { Project, ProjectList, ProjectStatus } from '@assetforge/contracts';
import { NotFoundError } from './errors.js';
import type { ProjectQuery } from './ports/project-repositories.js';
import type { WorkspaceSession } from './session.js';
import { tagName } from './tags.js';

export async function createProject(
  s: WorkspaceSession,
  input: { name: string; description?: string },
): Promise<Project> {
  const now = s.now().toISOString();
  const project: Project = {
    id: s.newId(),
    name: input.name,
    description: input.description ?? '',
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
  await s.database.projects.insert(project);
  return project;
}

export async function updateProject(
  s: WorkspaceSession,
  id: string,
  patch: { name?: string; description?: string; status?: ProjectStatus },
): Promise<Project> {
  const updated = await s.database.projects.update(id, { ...patch, updatedAt: s.now().toISOString() });
  if (updated === null) throw new NotFoundError(`Project ${id} does not exist`);
  return updated;
}

export async function getProject(s: WorkspaceSession, id: string): Promise<Project> {
  const project = await s.database.projects.get(id);
  if (project === null) throw new NotFoundError(`Project ${id} does not exist`);
  return project;
}

/** Trims the query (dropped when empty) and normalises and de-duplicates the tag names, as `listAssets` does. */
export async function listProjects(s: WorkspaceSession, q: ProjectQuery): Promise<ProjectList> {
  const { query, tagNames, ...rest } = q;
  const text = query?.trim() ?? '';
  const names = tagNames === undefined ? [] : [...new Set(tagNames.map((t) => tagName(t).name))];
  return s.database.projects.list({
    ...rest,
    ...(text.length > 0 && { query: text }),
    ...(names.length > 0 && { tagNames: names }),
  });
}
