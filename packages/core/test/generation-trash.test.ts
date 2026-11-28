import { describe, expect, it, vi } from 'vitest';
import { ANALYZE_FILE_JOB, IMAGE_GENERATE_JOB, type StartGeneration } from '@assetforge/contracts';
import { emptyTrash, InvalidOperationError, purgeFiles, startGeneration, trashFiles } from '../src/index.js';
import { trashForTest } from './fakes.js';
import { setup, VENICE_ID, type Setup } from './generation-setup.js';

const RUNNING_GENERATION = 'This file still has a running generation';

const edit = (fileId: string): StartGeneration => ({
  kind: 'edit',
  fileId,
  providerId: VENICE_ID,
  model: 'mock-edit',
  prompt: 'turn the head to the left',
  aspectRatio: '1:1',
  safeMode: false,
});

/** Starts a generation of the source and answers its id and the id of its job. */
async function started(t: Setup): Promise<{ generationId: string; jobId: string }> {
  const result = await startGeneration(t.session, t.deps, edit(t.file.id));
  if (!result.ok) throw new Error(`start answered ${result.code}`);
  return { generationId: result.generation.id, jobId: result.generation.jobId! };
}

const now = (t: Setup) => t.session.now().toISOString();
const claimGeneration = (t: Setup) =>
  t.db.jobs.claimNext({ resourceClass: 'remote_api', types: [IMAGE_GENERATE_JOB], now: now(t) });
const status = (t: Setup, jobId: string) => t.db.jobs.rows.find((r) => r.id === jobId)?.status;
const generationStatus = async (t: Setup, id: string) => (await t.db.generations.get(id))?.status;

async function analysisJob(t: Setup, id: string, running: boolean): Promise<void> {
  await t.db.jobs.enqueue({
    jobs: [
      {
        id,
        type: ANALYZE_FILE_JOB,
        resourceClass: 'local_gpu',
        fileId: t.file.id,
        lane: null,
        payload: {},
        dedupeKey: null,
      },
    ],
    now: now(t),
  });
  if (running) await t.db.jobs.claimNext({ resourceClass: 'local_gpu', types: [ANALYZE_FILE_JOB], now: now(t) });
}

describe('trashing the source of a generation', () => {
  it('leaves a running generation job, cancels a queued one only while pending, and cancels every other job', async () => {
    const t = await setup();
    const running = await started(t);
    expect((await claimGeneration(t))?.id).toBe(running.jobId);
    const queued = await started(t);
    await analysisJob(t, 'analysis-running', true);
    await analysisJob(t, 'analysis-queued', false);

    const [item] = await trashFiles(t.session, t.control, [t.file.id]);

    expect(item!.error).toBeNull();
    expect(t.control.cancelled).not.toContain(running.jobId);
    expect(t.control.cancelled.sort()).toEqual(['analysis-queued', 'analysis-running', queued.jobId].sort());
    // A queued generation is cancelled only while still pending: a claim meanwhile lets it run.
    expect(t.control.pendingOnly).toEqual([queued.jobId]);
    expect(status(t, running.jobId)).toBe('running');
    expect(await generationStatus(t, running.generationId)).toBe('pending');
    expect(status(t, queued.jobId)).toBe('cancelled');
    expect(await generationStatus(t, queued.generationId)).toBe('cancelled');
    expect(status(t, 'analysis-queued')).toBe('cancelled');
  });
});

describe('purging the source of a generation', () => {
  it('is refused while a generation of the file runs, before anything is written', async () => {
    const t = await setup();
    const running = await started(t);
    await claimGeneration(t);
    await analysisJob(t, 'late', false);
    // A control that cancels nothing leaves the analysis job queued in the trash.
    await trashForTest(t.session, [t.file.id]);
    const purge = vi.spyOn(t.db.files, 'purge');
    const moves = vi.spyOn(t.db.fileMoves, 'list');

    const [item] = await purgeFiles(t.session, t.control, [t.file.id]);

    expect(item!.error).toBeInstanceOf(InvalidOperationError);
    expect(item!.error!.message).toBe(RUNNING_GENERATION);
    expect(purge).not.toHaveBeenCalled();
    expect(moves).not.toHaveBeenCalled();
    expect(t.control.cancelled).toEqual([]);
    expect(status(t, 'late')).toBe('queued');
    expect(status(t, running.jobId)).toBe('running');
    expect(t.db.files.records.get(t.file.id)?.deletedAt).not.toBeNull();
  });

  it('is refused when the generation is claimed between the check and the cancel', async () => {
    const t = await setup();
    const g = await started(t);
    await trashForTest(t.session, [t.file.id]);
    const cancelPendingOfFile = t.db.jobs.cancelPendingOfFile.bind(t.db.jobs);
    t.db.jobs.cancelPendingOfFile = async (r) => {
      await claimGeneration(t);
      return cancelPendingOfFile(r);
    };
    const purge = vi.spyOn(t.db.files, 'purge');

    const [item] = await purgeFiles(t.session, t.control, [t.file.id]);

    expect(item!.error!.message).toBe(RUNNING_GENERATION);
    expect(purge).not.toHaveBeenCalled();
    expect(status(t, g.jobId)).toBe('running');
    expect(await generationStatus(t, g.generationId)).toBe('pending');
  });

  it('is refused by the purge itself when a generation of the file runs by then, keeping its job', async () => {
    const t = await setup();
    const g = await started(t);
    await trashForTest(t.session, [t.file.id]);
    // A generation of the file runs by the time the row goes: the purge transaction itself refuses.
    const purge = t.db.files.purge.bind(t.db.files);
    t.db.files.purge = async (id) => {
      const ended = t.db.jobs.rows.find((r) => r.id === g.jobId)!;
      t.db.jobs.rows.push({ ...ended, id: 'late-generation', status: 'running', finishedAt: null });
      return purge(id);
    };

    const [item] = await purgeFiles(t.session, t.control, [t.file.id]);

    expect(item!.error).toBeInstanceOf(InvalidOperationError);
    expect(item!.error!.message).toBe(RUNNING_GENERATION);
    expect(status(t, 'late-generation')).toBe('running');
    expect(t.db.files.records.get(t.file.id)?.deletedAt).not.toBeNull();
    expect(await generationStatus(t, g.generationId)).toBe('cancelled');
  });

  it('cancels a queued generation and settles it cancelled, then purges', async () => {
    const t = await setup();
    const g = await started(t);
    // A control that cancels nothing leaves the generation queued in the trash.
    await trashForTest(t.session, [t.file.id]);
    expect(status(t, g.jobId)).toBe('queued');

    const [item] = await purgeFiles(t.session, t.control, [t.file.id]);

    expect(item!.error).toBeNull();
    expect(t.db.files.records.has(t.file.id)).toBe(false);
    expect(await generationStatus(t, g.generationId)).toBe('cancelled');
  });

  it('emptying the trash counts a file with a running generation as failed and purges the others', async () => {
    const t = await setup();
    await started(t);
    await claimGeneration(t);
    const other = await t.importOne('other.png');
    await trashForTest(t.session, [t.file.id, other.id]);

    expect(await emptyTrash(t.session, t.control)).toEqual({ purged: 1, failed: 1 });
    expect(t.db.files.records.has(t.file.id)).toBe(true);
    expect(t.db.files.records.has(other.id)).toBe(false);
  });
});
