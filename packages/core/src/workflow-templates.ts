import type { WorkflowTemplate } from '@assetforge/contracts';
import type { WorkspaceDatabase } from './ports/workspace-database.js';
import type { WorkspaceSession } from './session.js';

export interface BuiltInStep {
  key: string;
  name: string;
  mandatory: boolean;
}

export interface BuiltInWorkflowTemplate {
  key: string;
  name: string;
  version: number;
  assetTypeKeys: readonly string[];
  steps: readonly BuiltInStep[];
}

const M = true;
const O = false;
const step = (key: string, name: string, mandatory: boolean): BuiltInStep => ({ key, name, mandatory });

/** The templates every workspace starts with; the step order is the step position. */
export const BUILT_IN_WORKFLOW_TEMPLATES: readonly BuiltInWorkflowTemplate[] = [
  {
    key: 'character',
    name: 'Character',
    version: 1,
    assetTypeKeys: ['character', 'creature'],
    steps: [
      step('references_collected', 'References collected', M),
      step('references_prepared', 'References prepared', O),
      step('character_views_generated', 'Character views generated', M),
      step('model_created', '3D model created', M),
      step('retopology_completed', 'Retopology completed', O),
      step('textures_materials_created', 'Textures / materials created', M),
      step('rigging_completed', 'Rigging completed', O),
      step('approved', 'Approved', M),
    ],
  },
  {
    key: 'landscape',
    name: 'Landscape',
    version: 1,
    assetTypeKeys: ['landscape'],
    steps: [
      step('references_collected', 'References collected', M),
      step('concept_images_created', 'Concept images created', M),
      step('terrain_created', 'Terrain created', M),
      step('materials_created', 'Materials created', M),
      step('vegetation_details_added', 'Vegetation and details added', O),
      step('approved', 'Approved', M),
    ],
  },
  {
    key: 'object',
    name: 'Object',
    version: 1,
    assetTypeKeys: ['building', 'vehicle', 'prop'],
    steps: [
      step('references_collected', 'References collected', M),
      step('concept_images_created', 'Concept images created', M),
      step('model_created', '3D model created', M),
      step('textures_materials_created', 'Textures / materials created', M),
      step('approved', 'Approved', M),
    ],
  },
  {
    key: 'material',
    name: 'Material',
    version: 1,
    assetTypeKeys: ['material'],
    steps: [
      step('references_collected', 'References collected', M),
      step('texture_set_created', 'Texture set created', M),
      step('material_assembled', 'Material assembled', M),
      step('approved', 'Approved', M),
    ],
  },
  {
    key: 'basic',
    name: 'Basic',
    version: 1,
    assetTypeKeys: ['other'],
    steps: [
      step('references_collected', 'References collected', O),
      step('work_completed', 'Work completed', M),
      step('approved', 'Approved', M),
    ],
  },
];

/**
 * Adds missing templates and template versions and sets the default template of asset types
 * that have none. Existing rows are never changed.
 */
export async function ensureBuiltInWorkflowTemplates(
  ctx: { database: WorkspaceDatabase; newId(): string; now(): Date },
  definitions: readonly BuiltInWorkflowTemplate[] = BUILT_IN_WORKFLOW_TEMPLATES,
): Promise<void> {
  const { workflowTemplates, assetTypes } = ctx.database;
  for (const def of definitions) {
    let templateId = (await workflowTemplates.findByKey(def.key))?.id;
    if (templateId === undefined) {
      templateId = ctx.newId();
      await workflowTemplates.insertTemplate({
        id: templateId,
        key: def.key,
        name: def.name,
        builtIn: true,
        createdAt: ctx.now().toISOString(),
      });
    }
    if (!(await workflowTemplates.hasVersion(templateId, def.version))) {
      await workflowTemplates.insertVersion({
        id: ctx.newId(),
        templateId,
        version: def.version,
        createdAt: ctx.now().toISOString(),
        steps: def.steps.map((s, position) => ({
          id: ctx.newId(),
          position,
          key: s.key,
          name: s.name,
          mandatory: s.mandatory,
        })),
      });
    }
    for (const typeKey of def.assetTypeKeys) {
      await assetTypes.setDefaultWorkflowTemplateIfUnset(typeKey, templateId);
    }
  }
}

export function listWorkflowTemplates(s: WorkspaceSession): Promise<WorkflowTemplate[]> {
  return s.database.workflowTemplates.list();
}
