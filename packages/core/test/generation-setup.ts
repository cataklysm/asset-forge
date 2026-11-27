import { Readable } from 'node:stream';
import { expect } from 'vitest';
import { IMAGE_GENERATE_JOB, type ImageModel, type ListImageModelsResult } from '@assetforge/contracts';
import {
  createImageGenerateHandler,
  InvalidOperationError,
  JobError,
  NotFoundError,
  WorkspaceManager,
  type ImageInput,
  type ImageProvider,
  type ImageProviderDirectory,
  type GenerationImageSource,
  type Job,
  type CancelOptions,
  type JobControl,
  type JobOutcome,
  type WorkspaceSession,
} from '../src/index.js';
import { createFakeHost } from './fakes.js';

export const ROOT = '/ws/a';
export const UNKNOWN_ID = '99999999-9999-4999-8999-999999999999';
export const VENICE_ID = '11111111-1111-4111-8111-111111111111';
export const OTHER_VENICE_ID = '22222222-2222-4222-8222-222222222222';
export const OLLAMA_ID = '33333333-3333-4333-8333-333333333333';
export const RESULT_BYTES = Buffer.from('generated-png');

export const MODELS: ImageModel[] = [
  {
    name: 'mock-edit',
    aspectRatios: ['1:1', '16:9'],
    resolutions: ['1K', '2K'],
    defaultResolution: '1K',
    promptCharacterLimit: 1500,
    price: null,
  },
  { name: 'free-edit', aspectRatios: null, resolutions: null, defaultResolution: null, promptCharacterLimit: null, price: null },
];

type Answer = { stream: Readable; mimeType: string };

/** Answers every edit and upscale with `answer()`; records each request without its signal. */
export class FakeImageProvider implements ImageProvider {
  readonly edits: { image: ImageInput; model: string; prompt: string; aspectRatio: string | null; resolution: string | null; safeMode: boolean }[] = [];
  readonly upscales: { image: ImageInput; scale: 2 | 4 }[] = [];
  answer: () => Promise<Answer> = async () => ({ stream: Readable.from([RESULT_BYTES]), mimeType: 'image/png' });

  async listEditModels(): Promise<ImageModel[]> {
    return structuredClone(MODELS);
  }

  async editImage(r: Parameters<ImageProvider['editImage']>[0]): Promise<Answer> {
    const { signal: _signal, ...rest } = r;
    this.edits.push(rest);
    return this.answer();
  }

  async upscaleImage(r: Parameters<ImageProvider['upscaleImage']>[0]): Promise<Answer> {
    this.upscales.push({ image: r.image, scale: r.scale });
    return this.answer();
  }
}

type Entry = { id: string; name: string; kind: 'ollama' | 'venice' };

/** The entries of a fake provider settings file; `lastUsed` names the image entry used last. */
export class FakeImageProviderDirectory implements ImageProviderDirectory {
  entries: Entry[] = [
    { id: OLLAMA_ID, name: 'Local', kind: 'ollama' },
    { id: VENICE_ID, name: 'Venice', kind: 'venice' },
    { id: OTHER_VENICE_ID, name: 'Venice 2', kind: 'venice' },
  ];
  lastUsed: string | null = null;
  readonly provider = new FakeImageProvider();
  modelsResult: ListImageModelsResult = { ok: true, models: structuredClone(MODELS) };
  readonly modelCalls: string[] = [];
  readonly used: string[] = [];

  resolve(id: string | undefined): { id: string; name: string } | null {
    const venice = this.entries.filter((e) => e.kind === 'venice');
    if (id === undefined) {
      const entry = venice.find((e) => e.id === this.lastUsed) ?? venice[0];
      return entry === undefined ? null : { id: entry.id, name: entry.name };
    }
    const entry = this.entries.find((e) => e.id === id);
    if (entry === undefined) throw new NotFoundError('This provider does not exist');
    if (entry.kind !== 'venice') throw new InvalidOperationError('This provider cannot generate images');
    return { id: entry.id, name: entry.name };
  }

  exists(id: string): boolean {
    return this.entries.some((e) => e.id === id);
  }

  adapter(id: string): ImageProvider | null {
    return this.entries.some((e) => e.id === id && e.kind === 'venice') ? this.provider : null;
  }

  async models(id: string): Promise<ListImageModelsResult> {
    this.modelCalls.push(id);
    return structuredClone(this.modelsResult);
  }

  markUsed(id: string): void {
    this.used.push(id);
  }
}

/** Answers `result` for every read (null when unset to null); records each file it was asked for. */
export class FakeGenerationImageSource implements GenerationImageSource {
  readonly reads: { absolutePath: string; mimeType: string; sha256: string; sizeBytes: number }[] = [];
  result: ImageInput | null = { data: new Uint8Array([1, 2, 3]), mimeType: 'image/png' };

  async read(file: { absolutePath: string; mimeType: string; sha256: string; sizeBytes: number }): Promise<ImageInput | null> {
    this.reads.push({ ...file });
    return this.result;
  }
}

/** A workspace with one imported `face.png` (640 × 480), the fake directory, image source, control and handler. */
export async function setup() {
  const fake = createFakeHost();
  const manager = new WorkspaceManager(fake.host);
  const summary = await manager.create({ name: 'Demo', rootPath: ROOT });
  const db = fake.databases.get(summary.id)!;
  const storage = fake.storages.get(ROOT)!;
  // A clock that ticks one second per reading, so created_at orders the generations as they were started.
  let clock = Date.parse('2026-01-01T00:00:00.000Z');
  fake.host.now = () => new Date((clock += 1000));
  const session: WorkspaceSession = await manager.read(async (s) => s);
  const importOne = async (name: string) => {
    fake.sources.set(`/src/${name}`, Buffer.from(name));
    return (await manager.importFiles([`/src/${name}`]))[0]!.file!;
  };
  const file = await importOne('face.png');
  const providers = new FakeImageProviderDirectory();
  const images = new FakeGenerationImageSource();
  /** What the handler reported through its effects; `throwing` makes every report throw. */
  const effects = { changed: [] as string[], added: [] as (string | null)[], throwing: false };
  const handler = createImageGenerateHandler({
    session,
    providers,
    images,
    effects: {
      fileChanged: (id) => {
        effects.changed.push(id);
        if (effects.throwing) throw new Error('listener failed');
      },
      fileAdded: (assetId) => {
        effects.added.push(assetId);
        if (effects.throwing) throw new Error('listener failed');
      },
    },
  });
  const control = new SettlingControl(session, handler);
  const deps = { providers, control };
  return { fake, manager, db, storage, session, importOne, file, providers, images, handler, control, deps, effects };
}

export type Setup = Awaited<ReturnType<typeof setup>>;

/**
 * Cancels like the scheduler: a pending job ends `cancelled` with the handler's `settled` in the same
 * transaction. Records every call.
 */
export class SettlingControl implements JobControl {
  wakes = 0;
  readonly cancelled: string[] = [];
  cancelAllCalls = 0;

  constructor(
    private readonly s: WorkspaceSession,
    private readonly handler: ReturnType<typeof createImageGenerateHandler>,
  ) {}

  wake(): void {
    this.wakes++;
  }

  /** The ids cancelled with `pendingOnly`; they are in `cancelled` too. */
  readonly pendingOnly: string[] = [];

  async cancel(jobId: string, options?: CancelOptions): Promise<void> {
    this.cancelled.push(jobId);
    if (options?.pendingOnly === true) this.pendingOnly.push(jobId);
    await this.s.database.jobs.cancelPending({
      id: jobId,
      now: this.s.now().toISOString(),
      settled: (job) => this.handler.settled!(job, { status: 'cancelled' }),
    });
  }

  async cancelAll(): Promise<number> {
    this.cancelAllCalls++;
    return 7;
  }
}

/** The outcome the scheduler derives from a run: success, or the run's `JobError` code (else `internal_error`). */
export function outcomeOf(error: unknown): JobOutcome {
  if (error === null) return { status: 'succeeded' };
  return { status: 'failed', errorCode: error instanceof JobError ? error.code : 'internal_error' };
}

/** Claims the next generation job, runs it and ends it like the scheduler does. Answers the job and the run's error. */
export async function runNext(t: Setup): Promise<{ job: Job; error: unknown }> {
  const now = () => t.session.now().toISOString();
  const job = await t.db.jobs.claimNext({ resourceClass: 'remote_api', types: [IMAGE_GENERATE_JOB], now: now() });
  if (job === null) throw new Error('No generation job is queued');
  const error = await t.handler.run(job, new AbortController().signal).then(
    () => null,
    (e: unknown) => e,
  );
  const outcome = outcomeOf(error);
  await t.db.jobs.finish(job.id, {
    status: outcome.status,
    errorCode: outcome.status === 'failed' ? outcome.errorCode : null,
    now: now(),
    settled: () => t.handler.settled!(job, outcome),
  });
  return { job, error };
}

export function expectJobError(error: unknown, code: JobError['code']): void {
  expect(error).toBeInstanceOf(JobError);
  expect((error as JobError).code).toBe(code);
}

/** A stream that yields one chunk, then fails like a cut-off answer. */
export function failingStream(): Readable {
  return Readable.from(
    (async function* () {
      yield Buffer.from('partial');
      throw new Error('socket hang up');
    })(),
  );
}
