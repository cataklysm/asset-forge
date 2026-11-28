import type { DescribeResult } from '@assetforge/contracts';
import { describeImage, JobError, type ModelImageSource, type VisionProvider, type WorkspaceManager } from '@assetforge/core';

// Image2Prompt requests: one at a time, cancellable by id, all cancelled when the workspace closes.
// Kept free of Electron imports. A provider failure answers its code; it is never logged here.

/** One Image2Prompt request. */
export interface DescribeRequest {
  /** The id the renderer cancels it by. */
  requestId: string;
  /** The image. */
  fileId: string;
  /** The model. */
  model: string;
  /** The prompt text. */
  prompt: string;
  /** The provider entry. */
  providerId: string;
}

/** Runs the Image2Prompt requests one at a time. */
export interface DescribeController {
  /**
   * `busy` while another request runs; `cancelled` once it was cancelled, and while a workspace
   * lifecycle step is under way (between `block` and `unblock`). Rejects with `no_workspace_open`.
   *
   * @param request the request
   * @returns the text or the failure code
   */
  describe(request: DescribeRequest): Promise<DescribeResult>;
  /**
   * Frees the slot at once; the cancelled request answers `cancelled`. An unknown or finished request is left alone.
   *
   * @param requestId the request
   */
  cancel(requestId: string): void;
  /**
   * Cancels the running request and waits until every cancelled run settled.
   *
   * @returns when they settled; never rejects
   */
  cancelAll(): Promise<void>;
  /** Refuses new requests while a workspace is open, until `unblock`. */
  block(): void;
  /** Takes new requests again. */
  unblock(): void;
}

/** What the describe controller runs with. */
export interface DescribeControllerDependencies {
  /** The workspace manager. */
  manager: WorkspaceManager;
  /** The adapter of a provider entry; null when the entry does not exist. */
  vision: (providerId: string) => VisionProvider | null;
  /** Reads the JPEG sent to the model. */
  images: ModelImageSource;
}

/** The running request. */
interface ActiveRequest {
  requestId: string;
  controller: AbortController;
  done: Promise<void>;
}

/**
 * Creates the describe controller.
 *
 * @param dependencies what it runs with
 * @returns the controller
 */
export function createDescribeController(dependencies: DescribeControllerDependencies): DescribeController {
  const requests = new DescribeRequests(dependencies);
  return {
    describe: (request) => requests.describe(request),
    cancel: (requestId) => requests.cancel(requestId),
    cancelAll: () => requests.cancelAll(),
    block: () => requests.block(),
    unblock: () => requests.unblock(),
  };
}

/** The running request, the cancelled ones still settling and the block. */
class DescribeRequests {
  private active: ActiveRequest | null = null;
  private blocked = false;
  /** Cancelled runs that have not settled yet, e.g. still waiting for the model JPEG. */
  private readonly settling = new Set<Promise<void>>();

  /** @param dependencies what the requests run with */
  constructor(private readonly dependencies: DescribeControllerDependencies) {}

  /**
   * Runs one request.
   *
   * @param input the request
   * @returns the text or the failure code
   */
  async describe(input: DescribeRequest): Promise<DescribeResult> {
    const { manager, vision, images } = this.dependencies;
    // Without a workspace the read below answers no_workspace_open.
    if (this.blocked && manager.current() !== null) return { ok: false, code: 'cancelled' };
    if (this.active !== null) return { ok: false, code: 'busy' };
    const controller = new AbortController();
    const { signal } = controller;
    const run = manager.read((session) =>
      describeImage(
        { session, vision: () => vision(input.providerId), images },
        { fileId: input.fileId, model: input.model, prompt: input.prompt, signal },
      ),
    );
    const request: ActiveRequest = { requestId: input.requestId, controller, done: run.then(() => {}, () => {}) };
    this.active = request;
    try {
      const text = await run;
      // Each request has its own signal, so a cancelled run's result never answers another request.
      return signal.aborted ? { ok: false, code: 'cancelled' } : { ok: true, text };
    } catch (error) {
      if (signal.aborted) return { ok: false, code: 'cancelled' };
      if (error instanceof JobError) return { ok: false, code: error.code };
      throw error;
    } finally {
      if (this.active === request) this.active = null;
    }
  }

  /**
   * Cancels the running request when it has this id.
   *
   * @param requestId the request
   */
  cancel(requestId: string): void {
    if (this.active?.requestId === requestId) this.abort(this.active);
  }

  /**
   * Cancels the running request and waits until every cancelled run settled.
   *
   * @returns when they settled
   */
  async cancelAll(): Promise<void> {
    if (this.active !== null) this.abort(this.active);
    await Promise.all([...this.settling]);
  }

  /** Refuses new requests while a workspace is open. */
  block(): void {
    this.blocked = true;
  }

  /** Takes new requests again. */
  unblock(): void {
    this.blocked = false;
  }

  /**
   * Aborts a request, frees the slot and keeps its run until it settled.
   *
   * @param request the request
   */
  private abort(request: ActiveRequest): void {
    request.controller.abort();
    if (this.active === request) this.active = null;
    this.settling.add(request.done);
    void request.done.then(() => this.settling.delete(request.done));
  }
}
