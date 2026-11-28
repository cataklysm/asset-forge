import { describe, expect, it, vi } from 'vitest';
import {
  BUILT_IN_WORKFLOW_TEMPLATES,
  InvalidOperationError,
  NotFoundError,
  WorkspaceManager,
  createAsset,
  ensureBuiltInWorkflowTemplates,
  getAsset,
  getWorkflow,
  listAssetTypes,
  removeWorkflow,
  startWorkflow,
  updateAsset,
  updateWorkflowStep,
  type WorkspaceSession,
} from '../src/index.js';
import { createFakeHost } from './fakes.js';

const ROOT = '/ws/a';
const UNKNOWN_ID = '99999999-9999-4999-8999-999999999999';

async function setup() {
  const fake = createFakeHost();
  let tick = 0;
  // A fixed clock that advances by one minute per call.
  fake.host.now = () => new Date(Date.UTC(2026, 0, 1, 0, tick++, 0));
  const manager = new WorkspaceManager(fake.host);
  const summary = await manager.create({ name: 'Demo', rootPath: ROOT });
  const db = fake.databases.get(summary.id)!;
  const session: WorkspaceSession = await manager.read(async (s) => s);
  const types = await listAssetTypes(session);
  const typeId = (key: string) => types.find((t) => t.key === key)!.id;
  const templateId = async (key: string) => (await db.workflowTemplates.findByKey(key))!.id;
  return { db, session, typeId, templateId };
}

async function character(ctx: Awaited<ReturnType<typeof setup>>, name = 'Hero') {
  const asset = await createAsset(ctx.session, { name, typeId: ctx.typeId('character') });
  const workflow = (await getWorkflow(ctx.session, asset.id))!;
  return { asset, workflow };
}

const stepIds = (w: { steps: { id: string }[] }) => w.steps.map((s) => s.id);

describe('starting workflows', () => {
  it('a new asset gets the workflow of its type', async () => {
    const ctx = await setup();
    const { asset, workflow } = await character(ctx);
    expect(workflow).toMatchObject({
      assetId: asset.id,
      templateId: await ctx.templateId('character'),
      templateName: 'Character',
      templateVersion: 1,
      progress: { done: 0, total: 5 },
    });
    expect(workflow.steps).toHaveLength(8);
    expect(workflow.steps.every((s) => s.state === 'not_started' && s.completedAt === null && s.notes === '')).toBe(
      true,
    );
  });

  it('an asset of a type without a default gets no workflow', async () => {
    const ctx = await setup();
    ctx.db.assetTypes.setDefaultWorkflowTemplate('prop', null);
    const asset = await createAsset(ctx.session, { name: 'Crate', typeId: ctx.typeId('prop') });
    expect(await getWorkflow(ctx.session, asset.id)).toBeNull();
  });

  it('an asset whose workflow cannot be written is not created either', async () => {
    const ctx = await setup();
    vi.spyOn(ctx.db.assetWorkflows, 'insert').mockRejectedValueOnce(new Error('disk I/O error'));

    await expect(createAsset(ctx.session, { name: 'Hero', typeId: ctx.typeId('character') })).rejects.toThrow(
      'disk I/O error',
    );

    expect(ctx.db.assets.rows.size).toBe(0);
    expect(ctx.db.assetWorkflows.workflows.size).toBe(0);
    expect(ctx.db.assetWorkflows.steps.size).toBe(0);
  });

  it('an asset whose default template has no version is not created', async () => {
    const ctx = await setup();
    vi.spyOn(ctx.db.workflowTemplates, 'latestVersion').mockResolvedValueOnce(null);

    await expect(createAsset(ctx.session, { name: 'Hero', typeId: ctx.typeId('character') })).rejects.toBeInstanceOf(
      InvalidOperationError,
    );

    expect(ctx.db.assets.rows.size).toBe(0);
    expect(ctx.db.assetWorkflows.workflows.size).toBe(0);
  });

  it('the fake writes the asset with its workflow as one, keeping nothing when a step row is refused', async () => {
    const ctx = await setup();
    const { asset } = await character(ctx);
    const { templateVersionId } = ctx.db.assetWorkflows.workflows.get(asset.id)!;
    const taken = [...ctx.db.assetWorkflows.steps.values()][0]!;
    const row = { id: UNKNOWN_ID, assetId: UNKNOWN_ID, templateVersionId, createdAt: 'x' };
    const second = { ...asset, id: UNKNOWN_ID, name: 'Second' };

    await expect(
      ctx.db.assets.insertWithWorkflow(second, {
        workflow: row,
        steps: [{ id: taken.id, stepDefinitionId: taken.stepDefinitionId, updatedAt: 'x' }],
      }),
    ).rejects.toThrow(/UNIQUE/);

    expect(ctx.db.assets.rows.has(UNKNOWN_ID)).toBe(false);
    expect(ctx.db.assetWorkflows.workflows.has(UNKNOWN_ID)).toBe(false);
  });

  it('the fake refuses an asset id that exists before writing, keeping the first asset', async () => {
    const ctx = await setup();
    const { asset } = await character(ctx);
    const { templateVersionId } = ctx.db.assetWorkflows.workflows.get(asset.id)!;
    const row = { id: UNKNOWN_ID, assetId: asset.id, templateVersionId, createdAt: 'x' };

    await expect(
      ctx.db.assets.insertWithWorkflow({ ...asset, name: 'Again' }, { workflow: row, steps: [] }),
    ).rejects.toThrow(/UNIQUE/);

    expect(ctx.db.assets.rows.get(asset.id)).toEqual(asset);
    expect(ctx.db.assetWorkflows.workflows.has(asset.id)).toBe(true);
  });

  it('can start one by naming a template', async () => {
    const ctx = await setup();
    ctx.db.assetTypes.setDefaultWorkflowTemplate('prop', null);
    const asset = await createAsset(ctx.session, { name: 'Crate', typeId: ctx.typeId('prop') });
    const workflow = await startWorkflow(ctx.session, asset.id, await ctx.templateId('basic'));
    expect(workflow).toMatchObject({ templateName: 'Basic', templateVersion: 1, progress: { done: 0, total: 2 } });
    expect(workflow.steps).toHaveLength(3);
    expect(await getWorkflow(ctx.session, asset.id)).toEqual(workflow);
  });

  it('starting without a template and without a default fails with invalid_operation', async () => {
    const ctx = await setup();
    ctx.db.assetTypes.setDefaultWorkflowTemplate('prop', null);
    const asset = await createAsset(ctx.session, { name: 'Crate', typeId: ctx.typeId('prop') });
    await expect(startWorkflow(ctx.session, asset.id)).rejects.toBeInstanceOf(InvalidOperationError);
    expect(await getWorkflow(ctx.session, asset.id)).toBeNull();
  });

  it('starting a second workflow fails with invalid_operation', async () => {
    const ctx = await setup();
    const { asset, workflow } = await character(ctx);
    await expect(startWorkflow(ctx.session, asset.id, await ctx.templateId('basic'))).rejects.toBeInstanceOf(
      InvalidOperationError,
    );
    expect(await getWorkflow(ctx.session, asset.id)).toEqual(workflow);
  });

  it('an unknown template fails with not_found', async () => {
    const ctx = await setup();
    ctx.db.assetTypes.setDefaultWorkflowTemplate('prop', null);
    const asset = await createAsset(ctx.session, { name: 'Crate', typeId: ctx.typeId('prop') });
    await expect(startWorkflow(ctx.session, asset.id, UNKNOWN_ID)).rejects.toBeInstanceOf(NotFoundError);
    expect(await getWorkflow(ctx.session, asset.id)).toBeNull();
  });

  it('an unknown asset fails with not_found', async () => {
    const ctx = await setup();
    await expect(startWorkflow(ctx.session, UNKNOWN_ID)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getWorkflow(ctx.session, UNKNOWN_ID)).rejects.toBeInstanceOf(NotFoundError);
    await expect(removeWorkflow(ctx.session, UNKNOWN_ID)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('the fake repository checks the foreign keys of the workflow row like SQLite', async () => {
    const ctx = await setup();
    const { asset } = await character(ctx);
    const { templateVersionId } = ctx.db.assetWorkflows.workflows.get(asset.id)!;
    await removeWorkflow(ctx.session, asset.id);
    const row = { id: UNKNOWN_ID, assetId: asset.id, templateVersionId, createdAt: 'x' };
    await expect(ctx.db.assetWorkflows.insert({ ...row, assetId: UNKNOWN_ID }, [])).rejects.toThrow(/FOREIGN KEY/);
    await expect(ctx.db.assetWorkflows.insert({ ...row, templateVersionId: UNKNOWN_ID }, [])).rejects.toThrow(
      /FOREIGN KEY/,
    );
    await ctx.db.assetWorkflows.insert(row, []);
  });
});

describe('updating steps', () => {
  it('marking a mandatory step done advances progress and sets completedAt', async () => {
    const ctx = await setup();
    const { workflow } = await character(ctx);
    const first = workflow.steps[0]!;
    expect(first.mandatory).toBe(true);
    const updated = await updateWorkflowStep(ctx.session, first.id, { state: 'done' });
    const step = updated.steps[0]!;
    expect(step.state).toBe('done');
    expect(step.completedAt).not.toBeNull();
    expect(step.completedAt).toBe(step.updatedAt);
    expect(step.updatedAt > first.updatedAt).toBe(true);
    expect(updated.progress).toEqual({ done: 1, total: 5 });
  });

  it('reopening a done step clears completedAt and lowers progress', async () => {
    const ctx = await setup();
    const { workflow } = await character(ctx);
    const id = workflow.steps[0]!.id;
    await updateWorkflowStep(ctx.session, id, { state: 'done' });
    const reopened = await updateWorkflowStep(ctx.session, id, { state: 'in_progress' });
    expect(reopened.steps[0]).toMatchObject({ state: 'in_progress', completedAt: null });
    expect(reopened.progress).toEqual({ done: 0, total: 5 });
  });

  it('done again sets a new completedAt', async () => {
    const ctx = await setup();
    const { workflow } = await character(ctx);
    const id = workflow.steps[0]!.id;
    const done = (await updateWorkflowStep(ctx.session, id, { state: 'done' })).steps[0]!;
    const stillDone = (await updateWorkflowStep(ctx.session, id, { state: 'done', notes: 'checked' })).steps[0]!;
    expect(stillDone.completedAt).toBe(done.completedAt);
    expect(stillDone.updatedAt > done.updatedAt).toBe(true);
    await updateWorkflowStep(ctx.session, id, { state: 'not_started' });
    const again = (await updateWorkflowStep(ctx.session, id, { state: 'done' })).steps[0]!;
    expect(again.completedAt).not.toBeNull();
    expect(again.completedAt! > done.completedAt!).toBe(true);
  });

  it('a notes-only update keeps state and completedAt', async () => {
    const ctx = await setup();
    const { workflow } = await character(ctx);
    const id = workflow.steps[0]!.id;
    const done = (await updateWorkflowStep(ctx.session, id, { state: 'done' })).steps[0]!;
    const noted = (await updateWorkflowStep(ctx.session, id, { notes: 'Front and side view' })).steps[0]!;
    expect(noted).toMatchObject({ state: 'done', completedAt: done.completedAt, notes: 'Front and side view' });
    expect(noted.updatedAt > done.updatedAt).toBe(true);

    const other = workflow.steps[1]!.id;
    const open = (await updateWorkflowStep(ctx.session, other, { notes: 'later' })).steps[1]!;
    expect(open).toMatchObject({ state: 'not_started', completedAt: null, notes: 'later' });
  });

  it('an optional step can be skipped and does not count', async () => {
    const ctx = await setup();
    const { workflow } = await character(ctx);
    const optional = workflow.steps[1]!;
    expect(optional.mandatory).toBe(false);
    const updated = await updateWorkflowStep(ctx.session, optional.id, { state: 'skipped' });
    expect(updated.steps[1]).toMatchObject({ state: 'skipped', completedAt: null });
    expect(updated.progress).toEqual({ done: 0, total: 5 });
  });

  it('skipping a mandatory step fails with invalid_operation and changes nothing', async () => {
    const ctx = await setup();
    const { asset, workflow } = await character(ctx);
    const error = await updateWorkflowStep(ctx.session, workflow.steps[0]!.id, {
      state: 'skipped',
      notes: 'nope',
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidOperationError);
    expect((error as InvalidOperationError).code).toBe('invalid_operation');
    expect(await getWorkflow(ctx.session, asset.id)).toEqual(workflow);
  });

  it('an unknown step fails with not_found', async () => {
    const ctx = await setup();
    await expect(updateWorkflowStep(ctx.session, UNKNOWN_ID, { state: 'done' })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('steps are independent', async () => {
    const ctx = await setup();
    const { workflow } = await character(ctx);
    const last = workflow.steps.at(-1)!;
    const updated = await updateWorkflowStep(ctx.session, last.id, { state: 'done' });
    expect(updated.steps.at(-1)!.state).toBe('done');
    expect(updated.steps[0]!.state).toBe('not_started');
    expect(updated.steps.slice(0, -1).every((s) => s.state === 'not_started')).toBe(true);
    expect(updated.progress).toEqual({ done: 1, total: 5 });
  });
});

describe('workflow and asset are independent', () => {
  it('finishing every mandatory step does not change the asset status', async () => {
    const ctx = await setup();
    const { asset, workflow } = await character(ctx);
    let latest = workflow;
    for (const step of workflow.steps.filter((s) => s.mandatory)) {
      latest = await updateWorkflowStep(ctx.session, step.id, { state: 'done' });
    }
    expect(latest.progress).toEqual({ done: 5, total: 5 });
    expect(await getAsset(ctx.session, asset.id)).toEqual(asset);
    expect(asset.status).toBe('draft');
  });

  it('changing the asset status does not change any step', async () => {
    const ctx = await setup();
    const { asset, workflow } = await character(ctx);
    await updateAsset(ctx.session, asset.id, { status: 'completed' });
    expect(await getWorkflow(ctx.session, asset.id)).toEqual(workflow);
  });

  it('changing the asset type keeps the workflow', async () => {
    const ctx = await setup();
    const { asset, workflow } = await character(ctx);
    await updateAsset(ctx.session, asset.id, { typeId: ctx.typeId('prop') });
    const after = await getWorkflow(ctx.session, asset.id);
    expect(after).toEqual(workflow);
    expect(after!.templateName).toBe('Character');
  });

  it('a new template version does not alter a running workflow', async () => {
    const ctx = await setup();
    const { asset, workflow } = await character(ctx);
    await updateWorkflowStep(ctx.session, workflow.steps[0]!.id, { state: 'done', notes: 'collected' });
    await updateWorkflowStep(ctx.session, workflow.steps[7]!.id, { state: 'in_progress' });
    const before = (await getWorkflow(ctx.session, asset.id))!;

    const def = BUILT_IN_WORKFLOW_TEMPLATES.find((t) => t.key === 'character')!;
    await ensureBuiltInWorkflowTemplates(ctx.session, [{ ...def, version: 2, steps: def.steps.slice(0, 4) }]);

    const after = (await getWorkflow(ctx.session, asset.id))!;
    expect(after).toEqual(before);
    expect(after.templateVersion).toBe(1);
    expect(after.steps).toHaveLength(8);
    expect(after.steps[0]).toMatchObject({ state: 'done', notes: 'collected' });
    expect(after.steps[7]!.state).toBe('in_progress');

    const fresh = (await character(ctx, 'Sidekick')).workflow;
    expect(fresh.templateVersion).toBe(2);
    expect(fresh.steps).toHaveLength(4);
    expect(stepIds(fresh).some((id) => stepIds(after).includes(id))).toBe(false);
  });
});

describe('removing workflows', () => {
  it('removing a workflow allows starting another template', async () => {
    const ctx = await setup();
    const { asset } = await character(ctx);
    expect(await removeWorkflow(ctx.session, asset.id)).toBe(true);
    expect(await getWorkflow(ctx.session, asset.id)).toBeNull();
    expect(await getAsset(ctx.session, asset.id)).toEqual(asset);

    const basic = await startWorkflow(ctx.session, asset.id, await ctx.templateId('basic'));
    expect(basic.templateName).toBe('Basic');
    expect(basic.steps).toHaveLength(3);

    ctx.db.assetTypes.setDefaultWorkflowTemplate('prop', null);
    const bare = await createAsset(ctx.session, { name: 'Crate', typeId: ctx.typeId('prop') });
    expect(await removeWorkflow(ctx.session, bare.id)).toBe(false);
  });
});
