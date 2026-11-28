import {
  listGenerationsForFile,
  recentGenerationPrompts,
  removeGeneration,
  retryGeneration,
  InvalidOperationError,
  startGeneration,
  type ImageProviderDirectory,
  type WorkspaceManager,
} from '@assetforge/core';
import type { IpcHandlers, IpcRequest, IpcResponse } from './ipc.js';
import type { JobHost } from './job-host.js';

// Kept free of Electron imports. Every channel runs inside the workspace read, so without a workspace it answers
// no_workspace_open whatever the ids; the provider entry is resolved inside it too.

/** The refusal of a second start for the same kind and source file while the first is still in the call. */
export const START_IN_FLIGHT_MESSAGE = 'A generation for this file is already being started';

/** The `generations:*` channels. */
export type GenerationHandlers = Pick<
  IpcHandlers,
  'generations:start' | 'generations:forFile' | 'generations:retry' | 'generations:remove' | 'generations:recentPrompts'
>;

/**
 * Builds the `generations:*` channels.
 *
 * @param manager the workspace manager
 * @param jobs the job host the generation jobs run on
 * @param directory the image provider entries
 * @returns one handler per channel
 */
export function createGenerationHandlers(
  manager: WorkspaceManager,
  jobs: JobHost,
  directory: ImageProviderDirectory,
): GenerationHandlers {
  const generations = new GenerationChannels(manager, jobs, directory);
  return {
    'generations:start': (request) => generations.start(request),
    'generations:forFile': (request) => manager.read((session) => listGenerationsForFile(session, request.fileId)),
    'generations:retry': (request) => generations.retry(request),
    'generations:remove': (request) => generations.remove(request),
    'generations:recentPrompts': async () => ({
      prompts: await manager.read((session) => recentGenerationPrompts(session)),
    }),
  };
}

/** The generation channels that change something, with the starts still in the call. */
class GenerationChannels {
  /**
   * The (kind, source file) pairs a start is being handled for: a paid start is never sent twice by a
   * repeated request while the first one is still in the call. Deliberate later variants stay possible.
   */
  private readonly inFlight = new Set<string>();
  /** What the core use cases run on. */
  private readonly dependencies: { providers: ImageProviderDirectory; control: JobHost };

  /**
   * @param manager the workspace manager
   * @param jobs the job host
   * @param directory the image provider entries
   */
  constructor(
    private readonly manager: WorkspaceManager,
    private readonly jobs: JobHost,
    directory: ImageProviderDirectory,
  ) {
    this.dependencies = { providers: directory, control: jobs };
  }

  /**
   * Starts a generation, refusing a second start of the same kind and file while the first is in the call.
   *
   * @param request the start
   * @returns the generation, or why it was not started
   * @throws InvalidOperationError while a start of the same kind and file is in the call
   */
  async start(request: IpcRequest<'generations:start'>): Promise<IpcResponse<'generations:start'>> {
    const key = `${request.kind}:${request.fileId}`;
    if (this.inFlight.has(key)) throw new InvalidOperationError(START_IN_FLIGHT_MESSAGE);
    this.inFlight.add(key);
    try {
      const result = await this.manager.read((session) => startGeneration(session, this.dependencies, request));
      // Core wakes the scheduler; the counter tells the renderer a job appeared.
      if (result.ok) this.jobs.changed();
      return result;
    } finally {
      this.inFlight.delete(key);
    }
  }

  /**
   * Runs a failed or cancelled generation again with a new job.
   *
   * @param request the generation
   * @returns the generation
   */
  async retry(request: IpcRequest<'generations:retry'>): Promise<IpcResponse<'generations:retry'>> {
    const generation = await this.manager.read((session) =>
      retryGeneration(session, this.dependencies, request.generationId),
    );
    this.jobs.changed();
    return generation;
  }

  /**
   * Removes a failed or cancelled generation.
   *
   * @param request the generation
   * @returns an empty answer
   */
  async remove(request: IpcRequest<'generations:remove'>): Promise<IpcResponse<'generations:remove'>> {
    await this.manager.read((session) => removeGeneration(session, request.generationId));
    return {};
  }
}
