import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Asset, AssetType } from '@assetforge/contracts';
import { BUILT_IN_ASSET_TYPES, type TemplateVersion, type WorkspaceDatabase } from '@assetforge/core';
import { MIGRATIONS_FOLDER, openWorkspaceDatabase } from '../src/index.js';

const TS = '2026-01-01T00:00:00.000Z';
const LATER = '2026-02-01T00:00:00.000Z';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const typeRows = (base: number): AssetType[] =>
  BUILT_IN_ASSET_TYPES.map((t, i) => ({
    id: uuid(base + i),
    key: t.key,
    name: t.name,
    sortOrder: i,
    builtIn: true,
    defaultWorkflowTemplateId: null,
  }));
const PROP = uuid(105);
const asset = (n: number, name: string): Asset => ({
  id: uuid(n),
  name,
  typeId: PROP,
  description: '',
  status: 'draft',
  createdAt: TS,
  updatedAt: TS,
});

const TEMPLATE = uuid(50);
const template = (id = TEMPLATE, key = 'character', name = 'Character') => ({
  id,
  key,
  name,
  builtIn: true,
  createdAt: TS,
});
/** Version 1: two mandatory and two optional steps, inserted out of position order. */
const version1: TemplateVersion = {
  id: uuid(60),
  templateId: TEMPLATE,
  version: 1,
  steps: [
    { id: uuid(62), position: 1, key: 'modeling', name: 'Modeling', mandatory: true },
    { id: uuid(61), position: 0, key: 'concept', name: 'Concept', mandatory: true },
    { id: uuid(64), position: 3, key: 'extras', name: 'Extras', mandatory: false },
    { id: uuid(63), position: 2, key: 'polish', name: 'Polish', mandatory: false },
  ],
};
const sortedSteps = [...version1.steps].sort((a, b) => a.position - b.position);

let dir: string;
let dbPath: string;
let db: WorkspaceDatabase;
let raw: Database.Database | undefined;

/** A second connection on the same file, with foreign keys enforced as the adapter does. */
function openRaw(): Database.Database {
  raw ??= new Database(dbPath);
  raw.pragma('foreign_keys = ON');
  return raw;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'af-wf-'));
  dbPath = join(dir, 'ws.db');
  db = await openWorkspaceDatabase(dbPath, MIGRATIONS_FOLDER);
});

afterEach(async () => {
  raw?.close();
  raw = undefined;
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

const seedTemplate = async () => {
  await db.workflowTemplates.insertTemplate(template());
  await db.workflowTemplates.insertVersion({ ...version1, createdAt: TS });
};

/** Types, the template with version 1, and asset 1 with a workflow (steps 71..74 by position). */
const seedWorkflow = async () => {
  await db.assetTypes.insertMissing(typeRows(100));
  await seedTemplate();
  await db.assets.insert(asset(1, 'Hero'));
  await db.assetWorkflows.insert(
    { id: uuid(70), assetId: uuid(1), templateVersionId: version1.id, createdAt: TS },
    sortedSteps.map((s, i) => ({ id: uuid(71 + i), stepDefinitionId: s.id, updatedAt: TS })),
  );
};

describe('workflow template repository', () => {
  test('insertVersion writes the version and its steps', async () => {
    await seedTemplate();
    expect(await db.workflowTemplates.latestVersion(TEMPLATE)).toEqual({ ...version1, steps: sortedSteps });
    await expect(db.workflowTemplates.hasVersion(TEMPLATE, 1)).resolves.toBe(true);
    await expect(db.workflowTemplates.hasVersion(TEMPLATE, 2)).resolves.toBe(false);
    await expect(db.workflowTemplates.findByKey('character')).resolves.toEqual({ id: TEMPLATE });
    await expect(db.workflowTemplates.findByKey('vehicle')).resolves.toBeNull();
  });

  test('latestVersion returns the highest version', async () => {
    await seedTemplate();
    const version2: TemplateVersion = {
      id: uuid(80),
      templateId: TEMPLATE,
      version: 2,
      steps: [{ id: uuid(81), position: 0, key: 'concept', name: 'Concept art', mandatory: false }],
    };
    await db.workflowTemplates.insertVersion({ ...version2, createdAt: LATER });
    expect(await db.workflowTemplates.latestVersion(TEMPLATE)).toEqual(version2);
    await expect(db.workflowTemplates.latestVersion(uuid(99))).resolves.toBeNull();
  });

  test('list reports latestVersion and omits templates without a version', async () => {
    await seedTemplate();
    await db.workflowTemplates.insertVersion({
      id: uuid(80),
      templateId: TEMPLATE,
      version: 2,
      steps: [],
      createdAt: LATER,
    });
    await db.workflowTemplates.insertTemplate(template(uuid(51), 'prop', 'A prop'));
    await db.workflowTemplates.insertTemplate(template(uuid(52), 'building', 'Building'));
    await db.workflowTemplates.insertVersion({ id: uuid(90), templateId: uuid(52), version: 1, steps: [], createdAt: TS });
    expect(await db.workflowTemplates.list()).toEqual([
      { id: uuid(52), key: 'building', name: 'Building', builtIn: true, latestVersion: 1 },
      { id: TEMPLATE, key: 'character', name: 'Character', builtIn: true, latestVersion: 2 },
    ]);
    await expect(db.workflowTemplates.get(TEMPLATE)).resolves.toEqual({
      id: TEMPLATE,
      key: 'character',
      name: 'Character',
      builtIn: true,
      latestVersion: 2,
    });
    await expect(db.workflowTemplates.get(uuid(51))).resolves.toBeNull();
    await expect(db.workflowTemplates.get(uuid(99))).resolves.toBeNull();
  });

  test('rejects a duplicate (template, version)', async () => {
    await seedTemplate();
    await expect(
      db.workflowTemplates.insertVersion({ id: uuid(80), templateId: TEMPLATE, version: 1, steps: [], createdAt: LATER }),
    ).rejects.toThrow(/UNIQUE/);
    expect(await db.workflowTemplates.latestVersion(TEMPLATE)).toEqual({ ...version1, steps: sortedSteps });
  });

  test('rejects a duplicate step key inside one version', async () => {
    await db.workflowTemplates.insertTemplate(template());
    await expect(
      db.workflowTemplates.insertVersion({
        id: uuid(60),
        templateId: TEMPLATE,
        version: 1,
        steps: [
          { id: uuid(61), position: 0, key: 'concept', name: 'Concept', mandatory: true },
          { id: uuid(62), position: 1, key: 'concept', name: 'Concept again', mandatory: true },
        ],
        createdAt: TS,
      }),
    ).rejects.toThrow(/UNIQUE/);
    // The transaction rolled back: no version row was left behind.
    await expect(db.workflowTemplates.hasVersion(TEMPLATE, 1)).resolves.toBe(false);
  });
});

describe('asset workflow repository', () => {
  test('insert creates one not_started step per definition', async () => {
    await seedWorkflow();
    expect(await db.assetWorkflows.getByAsset(uuid(1))).toEqual({
      id: uuid(70),
      assetId: uuid(1),
      templateId: TEMPLATE,
      templateName: 'Character',
      templateVersion: 1,
      createdAt: TS,
      progress: { done: 0, total: 2 },
      steps: sortedSteps.map((s, i) => ({
        id: uuid(71 + i),
        key: s.key,
        name: s.name,
        position: s.position,
        mandatory: s.mandatory,
        state: 'not_started',
        notes: '',
        updatedAt: TS,
        completedAt: null,
      })),
    });
    await expect(db.assetWorkflows.getStepContext(uuid(73))).resolves.toEqual({
      stepId: uuid(73),
      assetId: uuid(1),
      mandatory: false,
      state: 'not_started',
    });
    await expect(db.assetWorkflows.getStepContext(uuid(99))).resolves.toBeNull();
  });

  test('an asset cannot have two workflows', async () => {
    await seedWorkflow();
    await expect(
      db.assetWorkflows.insert(
        { id: uuid(75), assetId: uuid(1), templateVersionId: version1.id, createdAt: LATER },
        [{ id: uuid(76), stepDefinitionId: uuid(61), updatedAt: LATER }],
      ),
    ).rejects.toThrow(/UNIQUE/);
    expect(openRaw().prepare('SELECT count(*) AS n FROM asset_workflow_step').get()).toEqual({ n: 4 });
  });

  test('updateStep changes only the given fields', async () => {
    await seedWorkflow();
    await db.assetWorkflows.updateStep(uuid(71), { notes: 'first pass', updatedAt: LATER });
    await db.assetWorkflows.updateStep(uuid(72), { state: 'done', completedAt: LATER, updatedAt: LATER });
    const steps = (await db.assetWorkflows.getByAsset(uuid(1)))!.steps;
    expect(steps[0]).toMatchObject({ state: 'not_started', notes: 'first pass', updatedAt: LATER, completedAt: null });
    expect(steps[1]).toMatchObject({ state: 'done', notes: '', updatedAt: LATER, completedAt: LATER });
    expect(steps[2]).toMatchObject({ state: 'not_started', notes: '', updatedAt: TS, completedAt: null });
  });

  test('progress counts only mandatory done steps', async () => {
    await seedWorkflow();
    await db.assetWorkflows.updateStep(uuid(71), { state: 'done', completedAt: LATER, updatedAt: LATER });
    await db.assetWorkflows.updateStep(uuid(73), { state: 'done', completedAt: LATER, updatedAt: LATER });
    await db.assetWorkflows.updateStep(uuid(74), { state: 'skipped', updatedAt: LATER });
    expect((await db.assetWorkflows.getByAsset(uuid(1)))!.progress).toEqual({ done: 1, total: 2 });
  });

  test('rejects state done without completed_at', async () => {
    await seedWorkflow();
    const update = openRaw().prepare('UPDATE asset_workflow_step SET state = ?, completed_at = ? WHERE id = ?');
    expect(() => update.run('done', null, uuid(71))).toThrow(/CHECK/);
    expect(() => update.run('in_progress', LATER, uuid(71))).toThrow(/CHECK/);
    expect(() => update.run('blocked', null, uuid(71))).toThrow(/CHECK/);
  });

  test('remove deletes the workflow and its steps and nothing else', async () => {
    await seedWorkflow();
    const storage = await db.storages.ensurePrimary({ id: uuid(30), createdAt: TS });
    await db.files.insertPending({
      id: uuid(31),
      storageId: storage.id,
      originalName: 'a.png',
      relativePath: 'inbox/a.png',
      mimeType: 'image/png',
      importedAt: TS,
    });
    await db.files.setPlacement(uuid(31), { relativePath: `assets/${uuid(1)}/a.png`, assetId: uuid(1), role: 'reference' });
    await db.projects.insert({ id: uuid(40), name: 'P', description: '', status: 'active', createdAt: TS, updatedAt: TS });
    await db.projectAssets.insert({
      projectId: uuid(40),
      assetId: uuid(1),
      priority: 'normal',
      intendedUse: '',
      approvalStatus: 'pending',
      notes: '',
      assignedAt: TS,
      updatedAt: TS,
    });

    await expect(db.assetWorkflows.remove(uuid(1))).resolves.toBe(true);
    await expect(db.assetWorkflows.getByAsset(uuid(1))).resolves.toBeNull();
    const count = (table: string) => openRaw().prepare(`SELECT count(*) AS n FROM ${table}`).get();
    expect(count('asset_workflow_step')).toEqual({ n: 0 });
    expect(count('asset_workflow')).toEqual({ n: 0 });
    expect(count('workflow_step_definition')).toEqual({ n: 4 });
    await expect(db.assets.get(uuid(1))).resolves.toEqual(asset(1, 'Hero'));
    await expect(db.files.get(uuid(31))).resolves.toMatchObject({ assetId: uuid(1), role: 'reference' });
    await expect(db.projectAssets.listByAsset(uuid(1))).resolves.toHaveLength(1);
    await expect(db.assetWorkflows.remove(uuid(1))).resolves.toBe(false);
  });

  test('asset list carries workflow progress', async () => {
    await seedWorkflow();
    await db.assets.insert(asset(2, 'Lamp'));
    await db.assetWorkflows.updateStep(uuid(72), { state: 'done', completedAt: LATER, updatedAt: LATER });
    const list = await db.assets.list({ limit: 10, offset: 0 });
    expect(list.items.map((a) => [a.name, a.workflowProgress])).toEqual([
      ['Hero', { done: 1, total: 2 }],
      ['Lamp', null],
    ]);
  });
});

describe('asset type default template', () => {
  test('setDefaultWorkflowTemplateIfUnset does not replace an existing default', async () => {
    await db.assetTypes.insertMissing(typeRows(100));
    await seedTemplate();
    await db.workflowTemplates.insertTemplate(template(uuid(51), 'other', 'Other'));
    await db.assetTypes.setDefaultWorkflowTemplateIfUnset('character', TEMPLATE);
    await db.assetTypes.setDefaultWorkflowTemplateIfUnset('character', uuid(51));
    await expect(db.assetTypes.get(uuid(100))).resolves.toMatchObject({ defaultWorkflowTemplateId: TEMPLATE });
    await expect(db.assetTypes.get(uuid(101))).resolves.toMatchObject({ defaultWorkflowTemplateId: null });
  });
});
