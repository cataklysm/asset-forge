import type { AssetWorkflow, WorkflowProgress, WorkflowStep } from '@assetforge/contracts';
import type { AssetWorkflowRepository } from '@assetforge/core';
import { asc, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  assetWorkflow,
  assetWorkflowStep,
  workflowStepDefinition,
  workflowTemplate,
  workflowTemplateVersion,
} from './schema.js';

/** `done` = mandatory steps in state `done`, `total` = mandatory steps. */
const progressOf = (steps: readonly Pick<WorkflowStep, 'mandatory' | 'state'>[]): WorkflowProgress => {
  const mandatory = steps.filter((s) => s.mandatory);
  return { done: mandatory.filter((s) => s.state === 'done').length, total: mandatory.length };
};

export function createAssetWorkflowRepository(db: BetterSQLite3Database): AssetWorkflowRepository {
  return {
    async insert(w, steps) {
      db.transaction((tx) => {
        tx.insert(assetWorkflow)
          .values({ id: w.id, assetId: w.assetId, templateVersionId: w.templateVersionId, createdAt: w.createdAt })
          .run();
        for (const s of steps) {
          tx.insert(assetWorkflowStep)
            .values({
              id: s.id,
              assetWorkflowId: w.id,
              stepDefinitionId: s.stepDefinitionId,
              state: 'not_started',
              notes: '',
              updatedAt: s.updatedAt,
              completedAt: null,
            })
            .run();
        }
      });
    },
    async getByAsset(assetId): Promise<AssetWorkflow | null> {
      return db.transaction(
        (tx) => {
          const head = tx
            .select({
              id: assetWorkflow.id,
              assetId: assetWorkflow.assetId,
              templateId: workflowTemplate.id,
              templateName: workflowTemplate.name,
              templateVersion: workflowTemplateVersion.version,
              createdAt: assetWorkflow.createdAt,
            })
            .from(assetWorkflow)
            .innerJoin(workflowTemplateVersion, eq(workflowTemplateVersion.id, assetWorkflow.templateVersionId))
            .innerJoin(workflowTemplate, eq(workflowTemplate.id, workflowTemplateVersion.templateId))
            .where(eq(assetWorkflow.assetId, assetId))
            .get();
          if (!head) return null;
          const steps: WorkflowStep[] = tx
            .select({
              id: assetWorkflowStep.id,
              key: workflowStepDefinition.key,
              name: workflowStepDefinition.name,
              position: workflowStepDefinition.position,
              mandatory: workflowStepDefinition.mandatory,
              state: assetWorkflowStep.state,
              notes: assetWorkflowStep.notes,
              updatedAt: assetWorkflowStep.updatedAt,
              completedAt: assetWorkflowStep.completedAt,
            })
            .from(assetWorkflowStep)
            .innerJoin(workflowStepDefinition, eq(workflowStepDefinition.id, assetWorkflowStep.stepDefinitionId))
            .where(eq(assetWorkflowStep.assetWorkflowId, head.id))
            .orderBy(asc(workflowStepDefinition.position))
            .all();
          return { ...head, progress: progressOf(steps), steps };
        },
        { behavior: 'deferred' },
      );
    },
    async getStepContext(stepId) {
      return (
        db
          .select({
            stepId: assetWorkflowStep.id,
            assetId: assetWorkflow.assetId,
            mandatory: workflowStepDefinition.mandatory,
            state: assetWorkflowStep.state,
          })
          .from(assetWorkflowStep)
          .innerJoin(assetWorkflow, eq(assetWorkflow.id, assetWorkflowStep.assetWorkflowId))
          .innerJoin(workflowStepDefinition, eq(workflowStepDefinition.id, assetWorkflowStep.stepDefinitionId))
          .where(eq(assetWorkflowStep.id, stepId))
          .get() ?? null
      );
    },
    async updateStep(stepId, patch) {
      const set: Partial<typeof assetWorkflowStep.$inferInsert> = { updatedAt: patch.updatedAt };
      if (patch.state !== undefined) set.state = patch.state;
      if (patch.notes !== undefined) set.notes = patch.notes;
      if (patch.completedAt !== undefined) set.completedAt = patch.completedAt;
      db.update(assetWorkflowStep).set(set).where(eq(assetWorkflowStep.id, stepId)).run();
    },
    async remove(assetId) {
      // The step rows go with the workflow row (on delete cascade).
      const deleted = db.delete(assetWorkflow).where(eq(assetWorkflow.assetId, assetId)).run();
      return deleted.changes > 0;
    },
  };
}
