import type { WorkflowTemplate } from '@assetforge/contracts';
import type { TemplateVersion, WorkflowTemplateRepository } from '@assetforge/core';
import { and, asc, desc, eq, max, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { workflowStepDefinition, workflowTemplate, workflowTemplateVersion } from './schema.js';

/**
 * Template rows with their highest version; the inner join drops templates without a version.
 *
 * @param database the workspace database
 * @returns the dynamic statement
 */
const selectTemplates = (database: BetterSQLite3Database) =>
  database
    .select({
      id: workflowTemplate.id,
      key: workflowTemplate.key,
      name: workflowTemplate.name,
      builtIn: workflowTemplate.builtIn,
      latestVersion: max(workflowTemplateVersion.version).mapWith(Number),
    })
    .from(workflowTemplate)
    .innerJoin(workflowTemplateVersion, eq(workflowTemplateVersion.templateId, workflowTemplate.id))
    .groupBy(workflowTemplate.id)
    .$dynamic();

/**
 * The workflow template repository over the workspace database.
 *
 * @param database the workspace database
 * @returns the repository
 */
export function createWorkflowTemplateRepository(database: BetterSQLite3Database): WorkflowTemplateRepository {
  return {
    list: () => listTemplates(database),
    get: (id) => getTemplate(database, id),
    findByKey: (key) => findByKey(database, key),
    insertTemplate: (template) => insertTemplate(database, template),
    hasVersion: (templateId, version) => hasVersion(database, templateId, version),
    insertVersion: (version) => insertVersion(database, version),
    latestVersion: (templateId) => latestVersion(database, templateId),
  };
}

/**
 * Every template with a version, by name, then id.
 *
 * @param database the workspace database
 * @returns the templates
 */
async function listTemplates(database: BetterSQLite3Database): Promise<WorkflowTemplate[]> {
  return selectTemplates(database)
    .orderBy(sql`lower(${workflowTemplate.name})`, asc(workflowTemplate.id))
    .all();
}

/**
 * One template with a version.
 *
 * @param database the workspace database
 * @param id the template
 * @returns the template; null when unknown or without a version
 */
async function getTemplate(database: BetterSQLite3Database, id: string): Promise<WorkflowTemplate | null> {
  return selectTemplates(database).where(eq(workflowTemplate.id, id)).get() ?? null;
}

/**
 * The template with this key.
 *
 * @param database the workspace database
 * @param key the template key
 * @returns its id; null when unknown
 */
async function findByKey(database: BetterSQLite3Database, key: string): Promise<{ id: string } | null> {
  return (
    database.select({ id: workflowTemplate.id }).from(workflowTemplate).where(eq(workflowTemplate.key, key)).get() ??
    null
  );
}

/**
 * Inserts the template row.
 *
 * @param database the workspace database
 * @param template the template
 * @returns nothing
 */
async function insertTemplate(
  database: BetterSQLite3Database,
  template: Parameters<WorkflowTemplateRepository['insertTemplate']>[0],
): Promise<void> {
  database
    .insert(workflowTemplate)
    .values({
      id: template.id,
      key: template.key,
      name: template.name,
      builtIn: template.builtIn,
      createdAt: template.createdAt,
    })
    .run();
}

/**
 * Whether the template has this version.
 *
 * @param database the workspace database
 * @param templateId the template
 * @param version the version number
 * @returns true when it exists
 */
async function hasVersion(database: BetterSQLite3Database, templateId: string, version: number): Promise<boolean> {
  const row = database
    .select({ id: workflowTemplateVersion.id })
    .from(workflowTemplateVersion)
    .where(and(eq(workflowTemplateVersion.templateId, templateId), eq(workflowTemplateVersion.version, version)))
    .get();
  return row !== undefined;
}

/**
 * Inserts the version with its step definitions in one transaction.
 *
 * @param database the workspace database
 * @param version the version and its steps
 * @returns nothing
 */
async function insertVersion(
  database: BetterSQLite3Database,
  version: Parameters<WorkflowTemplateRepository['insertVersion']>[0],
): Promise<void> {
  database.transaction((transaction) => {
    transaction
      .insert(workflowTemplateVersion)
      .values({
        id: version.id,
        templateId: version.templateId,
        version: version.version,
        createdAt: version.createdAt,
      })
      .run();
    for (const step of version.steps) {
      transaction
        .insert(workflowStepDefinition)
        .values({
          id: step.id,
          templateVersionId: version.id,
          position: step.position,
          key: step.key,
          name: step.name,
          mandatory: step.mandatory,
        })
        .run();
    }
  });
}

/**
 * The template's highest version with its steps by position.
 *
 * @param database the workspace database
 * @param templateId the template
 * @returns the version; null when it has none
 */
async function latestVersion(database: BetterSQLite3Database, templateId: string): Promise<TemplateVersion | null> {
  return database.transaction(
    (transaction) => {
      const version = transaction
        .select()
        .from(workflowTemplateVersion)
        .where(eq(workflowTemplateVersion.templateId, templateId))
        .orderBy(desc(workflowTemplateVersion.version))
        .limit(1)
        .get();
      if (!version) return null;
      const steps = transaction
        .select({
          id: workflowStepDefinition.id,
          position: workflowStepDefinition.position,
          key: workflowStepDefinition.key,
          name: workflowStepDefinition.name,
          mandatory: workflowStepDefinition.mandatory,
        })
        .from(workflowStepDefinition)
        .where(eq(workflowStepDefinition.templateVersionId, version.id))
        .orderBy(asc(workflowStepDefinition.position))
        .all();
      return { id: version.id, templateId: version.templateId, version: version.version, steps };
    },
    { behavior: 'deferred' },
  );
}
