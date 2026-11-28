import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_ASSET_TYPES,
  BUILT_IN_WORKFLOW_TEMPLATES,
  WorkspaceManager,
  ensureBuiltInWorkflowTemplates,
  listWorkflowTemplates,
} from '../src/index.js';
import { createFakeHost, type InMemoryDatabase } from './fakes.js';

const ROOT = '/ws/a';

async function setup() {
  const fake = createFakeHost();
  const manager = new WorkspaceManager(fake.host);
  const summary = await manager.create({ name: 'Demo', rootPath: ROOT });
  const db = fake.databases.get(summary.id)!;
  return { ...fake, manager, summary, db };
}

async function snapshot(db: InMemoryDatabase) {
  const out: Record<string, unknown> = {};
  for (const t of await db.workflowTemplates.list()) {
    out[t.key] = { template: t.id, version: await db.workflowTemplates.latestVersion(t.id) };
  }
  return out;
}

describe('built-in workflow templates', () => {
  it('the built-in definitions are consistent', () => {
    const keys = BUILT_IN_WORKFLOW_TEMPLATES.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const t of BUILT_IN_WORKFLOW_TEMPLATES) {
      const stepKeys = t.steps.map((s) => s.key);
      expect(new Set(stepKeys).size).toBe(stepKeys.length);
      expect(t.steps.some((s) => s.mandatory)).toBe(true);
    }
    for (const type of BUILT_IN_ASSET_TYPES) {
      const owners = BUILT_IN_WORKFLOW_TEMPLATES.filter((t) => t.assetTypeKeys.includes(type.key));
      expect(owners, type.key).toHaveLength(1);
    }
  });

  // Every released template version, as `key@version` → its steps (`key:name:m` for mandatory, `:o` for
  // optional). A changed definition never reaches existing workspaces unless its version is raised: add the new
  // version here and keep the old lines.
  const RELEASED_VERSIONS: Record<string, string[]> = {
    'character@1': [
      'references_collected:References collected:m',
      'references_prepared:References prepared:o',
      'character_views_generated:Character views generated:m',
      'model_created:3D model created:m',
      'retopology_completed:Retopology completed:o',
      'textures_materials_created:Textures / materials created:m',
      'rigging_completed:Rigging completed:o',
      'approved:Approved:m',
    ],
    'landscape@1': [
      'references_collected:References collected:m',
      'concept_images_created:Concept images created:m',
      'terrain_created:Terrain created:m',
      'materials_created:Materials created:m',
      'vegetation_details_added:Vegetation and details added:o',
      'approved:Approved:m',
    ],
    'object@1': [
      'references_collected:References collected:m',
      'concept_images_created:Concept images created:m',
      'model_created:3D model created:m',
      'textures_materials_created:Textures / materials created:m',
      'approved:Approved:m',
    ],
    'material@1': [
      'references_collected:References collected:m',
      'texture_set_created:Texture set created:m',
      'material_assembled:Material assembled:m',
      'approved:Approved:m',
    ],
    'basic@1': [
      'references_collected:References collected:o',
      'work_completed:Work completed:m',
      'approved:Approved:m',
    ],
  };

  it('a built-in definition is never edited without raising its version', () => {
    for (const template of BUILT_IN_WORKFLOW_TEMPLATES) {
      const released = `${template.key}@${template.version}`;
      const steps = template.steps.map((s) => `${s.key}:${s.name}:${s.mandatory ? 'm' : 'o'}`);
      expect(steps, `${released}: raise the version and add it to RELEASED_VERSIONS`).toEqual(
        RELEASED_VERSIONS[released],
      );
    }
  });

  it('opening a workspace installs five templates at version 1 and sets every type default', async () => {
    const { db, manager } = await setup();
    const templates = await manager.read(listWorkflowTemplates);
    expect(templates.map((t) => t.key).sort()).toEqual(['basic', 'character', 'landscape', 'material', 'object']);
    expect(templates.every((t) => t.builtIn && t.latestVersion === 1)).toBe(true);

    const byKey = new Map(templates.map((t) => [t.key, t.id]));
    for (const def of BUILT_IN_WORKFLOW_TEMPLATES) {
      for (const typeKey of def.assetTypeKeys) {
        const type = (await db.assetTypes.list()).find((x) => x.key === typeKey)!;
        expect(type.defaultWorkflowTemplateId, typeKey).toBe(byKey.get(def.key));
      }
    }
    const character = await db.workflowTemplates.latestVersion(byKey.get('character')!);
    expect(character!.steps.map((s) => s.position)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(character!.steps[1]).toMatchObject({ key: 'references_prepared', mandatory: false });
  });

  it('reopening changes nothing', async () => {
    const { db, manager } = await setup();
    const before = await snapshot(db);
    await manager.close();
    await manager.open({ rootPath: ROOT });
    expect(await snapshot(db)).toEqual(before);
  });

  it('a bumped version is added next to the old one', async () => {
    const { db } = await setup();
    const character = BUILT_IN_WORKFLOW_TEMPLATES.find((t) => t.key === 'character')!;
    const templateId = (await db.workflowTemplates.findByKey('character'))!.id;
    const v1 = await db.workflowTemplates.latestVersion(templateId);

    const bumped = { ...character, version: 2, steps: character.steps.slice(0, -1) };
    await ensureBuiltInWorkflowTemplates({ database: db, newId: () => crypto.randomUUID(), now: () => new Date() }, [
      bumped,
    ]);

    const latest = await db.workflowTemplates.latestVersion(templateId);
    expect(latest!.version).toBe(2);
    expect(latest!.steps).toHaveLength(character.steps.length - 1);
    expect((await db.workflowTemplates.findByKey('character'))!.id).toBe(templateId);
    expect(await db.workflowTemplates.hasVersion(templateId, 1)).toBe(true);
    expect(v1!.steps).toHaveLength(character.steps.length);
  });

  it('does not replace a default that is already set', async () => {
    const { db } = await setup();
    const other = crypto.randomUUID();
    db.assetTypes.setDefaultWorkflowTemplate('prop', other);
    await ensureBuiltInWorkflowTemplates({ database: db, newId: () => crypto.randomUUID(), now: () => new Date() });
    const prop = (await db.assetTypes.list()).find((x) => x.key === 'prop')!;
    expect(prop.defaultWorkflowTemplateId).toBe(other);
  });
});
