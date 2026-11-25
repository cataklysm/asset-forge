import type { WorkflowTemplate } from '@assetforge/contracts';
import type { TemplateVersion, WorkflowTemplateRepository } from '@assetforge/core';
import { and, asc, desc, eq, max, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { workflowStepDefinition, workflowTemplate, workflowTemplateVersion } from './schema.js';

/** Template rows with their highest version; the inner join drops templates without a version. */
const selectTemplates = (db: BetterSQLite3Database) =>
  db
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

export function createWorkflowTemplateRepository(db: BetterSQLite3Database): WorkflowTemplateRepository {
  return {
    async list(): Promise<WorkflowTemplate[]> {
      return selectTemplates(db).orderBy(sql`lower(${workflowTemplate.name})`, asc(workflowTemplate.id)).all();
    },
    async get(id) {
      return selectTemplates(db).where(eq(workflowTemplate.id, id)).get() ?? null;
    },
    async findByKey(key) {
      return db.select({ id: workflowTemplate.id }).from(workflowTemplate).where(eq(workflowTemplate.key, key)).get() ?? null;
    },
    async insertTemplate(t) {
      db.insert(workflowTemplate)
        .values({ id: t.id, key: t.key, name: t.name, builtIn: t.builtIn, createdAt: t.createdAt })
        .run();
    },
    async hasVersion(templateId, version) {
      const row = db
        .select({ id: workflowTemplateVersion.id })
        .from(workflowTemplateVersion)
        .where(and(eq(workflowTemplateVersion.templateId, templateId), eq(workflowTemplateVersion.version, version)))
        .get();
      return row !== undefined;
    },
    async insertVersion(v) {
      db.transaction((tx) => {
        tx.insert(workflowTemplateVersion)
          .values({ id: v.id, templateId: v.templateId, version: v.version, createdAt: v.createdAt })
          .run();
        for (const s of v.steps) {
          tx.insert(workflowStepDefinition)
            .values({
              id: s.id,
              templateVersionId: v.id,
              position: s.position,
              key: s.key,
              name: s.name,
              mandatory: s.mandatory,
            })
            .run();
        }
      });
    },
    async latestVersion(templateId): Promise<TemplateVersion | null> {
      return db.transaction(
        (tx) => {
          const version = tx
            .select()
            .from(workflowTemplateVersion)
            .where(eq(workflowTemplateVersion.templateId, templateId))
            .orderBy(desc(workflowTemplateVersion.version))
            .limit(1)
            .get();
          if (!version) return null;
          const steps = tx
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
    },
  };
}
