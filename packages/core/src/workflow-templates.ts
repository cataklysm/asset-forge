import type { WorkflowTemplate } from '@assetforge/contracts';
import type { WorkspaceDatabase } from './ports/workspace-database.js';
import type { WorkspaceSession } from './session.js';

/** One step of a built-in template. */
export interface BuiltInStep {
  /** The stable key. */
  key: string;
  /** The display name. */
  name: string;
  /** Whether the step counts for the progress and cannot be skipped. */
  mandatory: boolean;
}

/** A built-in workflow template in one version. */
export interface BuiltInWorkflowTemplate {
  /** The stable key. */
  key: string;
  /** The display name. */
  name: string;
  /** The version; a new number adds a template version. */
  version: number;
  /** The asset types this template becomes the default of, when they have none. */
  assetTypeKeys: readonly string[];
  /** The steps in order. */
  steps: readonly BuiltInStep[];
}

/** What the template synchronisation needs. */
interface TemplateContext {
  /** The open database. */
  database: WorkspaceDatabase;
  /** The id source. */
  newId(): string;
  /** The clock. */
  now(): Date;
}

/** Marks a mandatory step in the table below. */
const MANDATORY = true;
/** Marks an optional step in the table below. */
const OPTIONAL = false;

/**
 * One step of the table below.
 *
 * @param key the stable key
 * @param name the display name
 * @param mandatory whether it is mandatory
 * @returns the step
 */
function step(key: string, name: string, mandatory: boolean): BuiltInStep {
  return { key, name, mandatory };
}

/** The templates every workspace starts with; the step order is the step position. */
export const BUILT_IN_WORKFLOW_TEMPLATES: readonly BuiltInWorkflowTemplate[] = [
  {
    key: 'character',
    name: 'Character',
    version: 1,
    assetTypeKeys: ['character', 'creature'],
    steps: [
      step('references_collected', 'References collected', MANDATORY),
      step('references_prepared', 'References prepared', OPTIONAL),
      step('character_views_generated', 'Character views generated', MANDATORY),
      step('model_created', '3D model created', MANDATORY),
      step('retopology_completed', 'Retopology completed', OPTIONAL),
      step('textures_materials_created', 'Textures / materials created', MANDATORY),
      step('rigging_completed', 'Rigging completed', OPTIONAL),
      step('approved', 'Approved', MANDATORY),
    ],
  },
  {
    key: 'landscape',
    name: 'Landscape',
    version: 1,
    assetTypeKeys: ['landscape'],
    steps: [
      step('references_collected', 'References collected', MANDATORY),
      step('concept_images_created', 'Concept images created', MANDATORY),
      step('terrain_created', 'Terrain created', MANDATORY),
      step('materials_created', 'Materials created', MANDATORY),
      step('vegetation_details_added', 'Vegetation and details added', OPTIONAL),
      step('approved', 'Approved', MANDATORY),
    ],
  },
  {
    key: 'object',
    name: 'Object',
    version: 1,
    assetTypeKeys: ['building', 'vehicle', 'prop'],
    steps: [
      step('references_collected', 'References collected', MANDATORY),
      step('concept_images_created', 'Concept images created', MANDATORY),
      step('model_created', '3D model created', MANDATORY),
      step('textures_materials_created', 'Textures / materials created', MANDATORY),
      step('approved', 'Approved', MANDATORY),
    ],
  },
  {
    key: 'material',
    name: 'Material',
    version: 1,
    assetTypeKeys: ['material'],
    steps: [
      step('references_collected', 'References collected', MANDATORY),
      step('texture_set_created', 'Texture set created', MANDATORY),
      step('material_assembled', 'Material assembled', MANDATORY),
      step('approved', 'Approved', MANDATORY),
    ],
  },
  {
    key: 'basic',
    name: 'Basic',
    version: 1,
    assetTypeKeys: ['other'],
    steps: [
      step('references_collected', 'References collected', OPTIONAL),
      step('work_completed', 'Work completed', MANDATORY),
      step('approved', 'Approved', MANDATORY),
    ],
  },
];

/**
 * Adds missing templates and template versions and sets the default template of asset types
 * that have none. Existing rows are never changed.
 *
 * @param context the open database, the id source and the clock
 * @param definitions the templates to synchronise
 * @returns resolves once every definition is synchronised
 */
export async function ensureBuiltInWorkflowTemplates(
  context: TemplateContext,
  definitions: readonly BuiltInWorkflowTemplate[] = BUILT_IN_WORKFLOW_TEMPLATES,
): Promise<void> {
  for (const definition of definitions) {
    const templateId = await ensureTemplate(context, definition);
    await ensureVersion(context, templateId, definition);
    for (const typeKey of definition.assetTypeKeys) {
      await context.database.assetTypes.setDefaultWorkflowTemplateIfUnset(typeKey, templateId);
    }
  }
}

/**
 * The template row of a definition, inserted when its key is not present yet.
 *
 * @param context the open database, the id source and the clock
 * @param definition the template
 * @returns the template id
 */
async function ensureTemplate(context: TemplateContext, definition: BuiltInWorkflowTemplate): Promise<string> {
  const { workflowTemplates } = context.database;
  const existingId = (await workflowTemplates.findByKey(definition.key))?.id;
  if (existingId !== undefined) return existingId;
  const templateId = context.newId();
  await workflowTemplates.insertTemplate({
    id: templateId,
    key: definition.key,
    name: definition.name,
    builtIn: true,
    createdAt: context.now().toISOString(),
  });
  return templateId;
}

/**
 * Inserts the definition's version with its steps when the template does not have it yet.
 *
 * @param context the open database, the id source and the clock
 * @param templateId the template
 * @param definition the template in its version
 * @returns resolves once the version exists
 */
async function ensureVersion(
  context: TemplateContext,
  templateId: string,
  definition: BuiltInWorkflowTemplate,
): Promise<void> {
  const { workflowTemplates } = context.database;
  if (await workflowTemplates.hasVersion(templateId, definition.version)) return;
  await workflowTemplates.insertVersion({
    id: context.newId(),
    templateId,
    version: definition.version,
    createdAt: context.now().toISOString(),
    steps: definition.steps.map((builtIn, position) => ({
      id: context.newId(),
      position,
      key: builtIn.key,
      name: builtIn.name,
      mandatory: builtIn.mandatory,
    })),
  });
}

/**
 * The workflow templates of the workspace.
 *
 * @param session the open workspace
 * @returns them
 */
export function listWorkflowTemplates(session: WorkspaceSession): Promise<WorkflowTemplate[]> {
  return session.database.workflowTemplates.list();
}
