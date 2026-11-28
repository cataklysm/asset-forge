import type { Project, ProjectList } from '@assetforge/contracts';
import type { ProjectQuery, ProjectRepository } from '@assetforge/core';
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { projectPage } from './project-list.js';
import { project } from './schema.js';

/**
 * The project of a row.
 *
 * @param row the project row
 * @returns the project
 */
const toProject = (row: typeof project.$inferSelect): Project => ({
  id: row.id,
  name: row.name,
  description: row.description,
  status: row.status,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/**
 * The project repository over the workspace database.
 *
 * @param database the workspace database
 * @returns the repository
 */
export function createProjectRepository(database: BetterSQLite3Database): ProjectRepository {
  return {
    insert: (newProject) => insertProject(database, newProject),
    get: (id) => getProject(database, id),
    update: (id, patch) => updateProject(database, id, patch),
    list: (query) => listProjects(database, query),
  };
}

/**
 * Inserts the project.
 *
 * @param database the workspace database
 * @param newProject the project
 * @returns nothing
 */
async function insertProject(database: BetterSQLite3Database, newProject: Project): Promise<void> {
  database
    .insert(project)
    .values({
      id: newProject.id,
      name: newProject.name,
      description: newProject.description,
      status: newProject.status,
      createdAt: newProject.createdAt,
      updatedAt: newProject.updatedAt,
    })
    .run();
}

/**
 * One project.
 *
 * @param database the workspace database
 * @param id the project
 * @returns the project; null when unknown
 */
async function getProject(database: BetterSQLite3Database, id: string): Promise<Project | null> {
  const row = database.select().from(project).where(eq(project.id, id)).get();
  return row ? toProject(row) : null;
}

/**
 * Changes the given fields and the update time.
 *
 * @param database the workspace database
 * @param id the project
 * @param patch the fields to change with the update time
 * @returns the changed project; null when unknown
 */
async function updateProject(
  database: BetterSQLite3Database,
  id: string,
  patch: Parameters<ProjectRepository['update']>[1],
): Promise<Project | null> {
  const set: Partial<typeof project.$inferInsert> = { updatedAt: patch.updatedAt };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.description !== undefined) set.description = patch.description;
  if (patch.status !== undefined) set.status = patch.status;
  const row = database.update(project).set(set).where(eq(project.id, id)).returning().get();
  return row ? toProject(row) : null;
}

/**
 * One page of the project list.
 *
 * @param database the workspace database
 * @param query the filters and the page
 * @returns the page and the total
 */
async function listProjects(database: BetterSQLite3Database, query: ProjectQuery): Promise<ProjectList> {
  // One read transaction, so the page, the matched tags and the total describe the same snapshot.
  return database.transaction((transaction) => projectPage(transaction, query), { behavior: 'deferred' });
}
