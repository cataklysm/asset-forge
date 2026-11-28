import type { AssetWorkflow } from '@assetforge/contracts';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { WorkflowSection } from '../../src/renderer/src/components/WorkflowSection';
import { useWorkflow } from '../../src/renderer/src/hooks/useWorkflow';
import { deferred, fakeError, installFakeApi, type FakeHandlers } from './fake-api';
import { nextId } from './fixtures';

const ASSET_ID = nextId();
const TYPE_ID = nextId();

function workflowOf(steps: { name: string; mandatory: boolean; state?: 'not_started' | 'done' }[]): AssetWorkflow {
  return {
    id: nextId(),
    assetId: ASSET_ID,
    templateId: nextId(),
    templateName: 'Basic',
    templateVersion: 1,
    createdAt: '2026-11-28T00:00:00.000Z',
    progress: {
      done: steps.filter((step) => step.mandatory && step.state === 'done').length,
      total: steps.filter((step) => step.mandatory).length,
    },
    steps: steps.map((step, position) => ({
      id: nextId(),
      key: step.name.toLowerCase(),
      name: step.name,
      position,
      mandatory: step.mandatory,
      state: step.state ?? 'not_started',
      notes: '',
      updatedAt: '2026-11-28T00:00:00.000Z',
      completedAt: null,
    })),
  };
}

function install(handlers: FakeHandlers) {
  return installFakeApi({
    'workflowTemplates:list': () => [],
    'assetTypes:list': () => [],
    ...handlers,
  });
}

it('a workflow without mandatory steps shows no progress bar', async () => {
  const workflow = workflowOf([{ name: 'Sketch', mandatory: false }]);
  install({ 'workflows:get': () => workflow });
  render(<WorkflowSection assetId={ASSET_ID} assetTypeId={TYPE_ID} />);
  await screen.findByRole('combobox', { name: 'State of Sketch' });
  expect(screen.getByText(/0 \/ 0/)).toBeTruthy();
  expect(screen.queryByRole('progressbar')).toBeNull();
});

it('removing the workflow reads back what the main process holds', async () => {
  const user = userEvent.setup();
  const workflow = workflowOf([{ name: 'Model', mandatory: true }]);
  let stored: AssetWorkflow | null = workflow;
  const api = install({
    'workflows:get': () => stored,
    'workflows:remove': () => {
      stored = null;
      return { removed: true };
    },
  });
  render(<WorkflowSection assetId={ASSET_ID} assetTypeId={TYPE_ID} />);
  await user.click(await screen.findByRole('button', { name: 'Remove workflow' }));
  await screen.findByRole('button', { name: 'Start workflow' });
  expect(api.calls.filter((call) => call.channel === 'workflows:get')).toHaveLength(2);
});

it('of two saves in flight, the answer of the later one stays', async () => {
  const user = userEvent.setup();
  const workflow = workflowOf([{ name: 'Model', mandatory: true }]);
  const withState = (state: 'in_progress' | 'done'): AssetWorkflow => ({
    ...workflow,
    steps: [{ ...workflow.steps[0]!, state }],
  });
  const first = deferred<AssetWorkflow>();
  const second = deferred<AssetWorkflow>();
  const answers = [first, second];
  install({
    'workflows:get': () => workflow,
    'workflows:updateStep': () => answers.shift()!.promise,
  });
  render(<WorkflowSection assetId={ASSET_ID} assetTypeId={TYPE_ID} />);
  const select = await screen.findByRole<HTMLSelectElement>('combobox', { name: 'State of Model' });

  await user.selectOptions(select, 'in_progress');
  await user.selectOptions(select, 'done');
  second.resolve(withState('done'));
  await waitFor(() => expect(select.value).toBe('done'));
  first.resolve(withState('in_progress'));
  await first.promise;
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(select.value).toBe('done');
});

it('an earlier save that fails after a later one succeeded still reports its error', async () => {
  const workflow = workflowOf([{ name: 'Model', mandatory: true }]);
  const done: AssetWorkflow = { ...workflow, steps: [{ ...workflow.steps[0]!, state: 'done' }] };
  const first = deferred<AssetWorkflow>();
  const second = deferred<AssetWorkflow>();
  const answers = [first, second];
  install({
    'workflows:get': () => workflow,
    'workflows:updateStep': () => answers.shift()!.promise,
  });
  const { result } = renderHook(() => useWorkflow(ASSET_ID, TYPE_ID));
  await waitFor(() => expect(result.current.workflow).not.toBeNull());
  const stepId = workflow.steps[0]!.id;

  let firstSave!: Promise<boolean>;
  act(() => {
    firstSave = result.current.updateStep(stepId, { notes: 'first' });
  });
  let secondSave!: Promise<boolean>;
  act(() => {
    secondSave = result.current.updateStep(stepId, { state: 'done' });
  });
  await act(async () => {
    second.resolve(done);
    await secondSave;
  });
  let firstResult: boolean | undefined;
  await act(async () => {
    first.reject(fakeError('invalid_operation', 'The step could not be saved'));
    firstResult = await firstSave;
  });

  expect(firstResult).toBe(false);
  expect(result.current.error).toBe('The step could not be saved');
});

it('after a failed save the workflow is read back from the main process', async () => {
  const user = userEvent.setup();
  const workflow = workflowOf([{ name: 'Model', mandatory: true }]);
  let stored = workflow;
  const first = deferred<AssetWorkflow>();
  let saves = 0;
  install({
    'workflows:get': () => stored,
    'workflows:updateStep': () => {
      saves += 1;
      if (saves === 2) throw fakeError('invalid_operation', 'The step could not be saved');
      stored = { ...workflow, steps: [{ ...workflow.steps[0]!, state: 'in_progress' }] };
      return first.promise;
    },
  });
  render(<WorkflowSection assetId={ASSET_ID} assetTypeId={TYPE_ID} />);
  const select = await screen.findByRole<HTMLSelectElement>('combobox', { name: 'State of Model' });

  await user.selectOptions(select, 'in_progress');
  await user.selectOptions(select, 'done');
  await screen.findByText('The step could not be saved');
  first.resolve(stored);
  await first.promise;

  await waitFor(() => expect(select.value).toBe('in_progress'));
});

it('two loads failing with the same message show two alert lines without a key clash', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const fail = () => {
    throw fakeError('storage_unreachable');
  };
  install({ 'workflows:get': fail, 'workflowTemplates:list': fail });
  render(<WorkflowSection assetId={ASSET_ID} assetTypeId={TYPE_ID} />);
  await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(2));
  const clash = errors.mock.calls.some((call) => String(call[0]).includes('same key'));
  errors.mockRestore();
  expect(clash).toBe(false);
});
