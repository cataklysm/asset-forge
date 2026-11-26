import type { DescribeResult } from '@assetforge/contracts';
import { describeImage, JobError, type ModelImageSource, type VisionProvider, type WorkspaceManager } from '@assetforge/core';

// Image2Prompt requests: one at a time, cancellable by id, all cancelled when the workspace closes.
// Kept free of Electron imports. A provider failure answers its code; it is never logged here.

export interface DescribeController {
  /**
   * `busy` while another request runs; `cancelled` once it was cancelled, and while a workspace
   * lifecycle step is under way (between `block` and `unblock`). Rejects with `no_workspace_open`.
   */
  describe(r: { requestId: string; fileId: string; model: string; prompt: string; providerId: string }): Promise<DescribeResult>;
  /** Frees the slot at once; the cancelled request answers `cancelled`. An unknown or finished request is left alone. */
  cancel(requestId: string): void;
  /** Cancels the running request and waits until every cancelled run settled. Never rejects. */
  cancelAll(): Promise<void>;
  /** Refuses new requests while a workspace is open, until `unblock`. */
  block(): void;
  unblock(): void;
}

interface ActiveRequest {
  requestId: string;
  controller: AbortController;
  done: Promise<void>;
}

export function createDescribeController(deps: {
  manager: WorkspaceManager;
  /** The adapter of a provider entry; null when the entry does not exist. */
  vision: (providerId: string) => VisionProvider | null;
  images: ModelImageSource;
}): DescribeController {
  let active: ActiveRequest | null = null;
  let blocked = false;
  /** Cancelled runs that have not settled yet, e.g. still waiting for the model JPEG. */
  const settling = new Set<Promise<void>>();

  const abort = (request: ActiveRequest) => {
    request.controller.abort();
    if (active === request) active = null;
    settling.add(request.done);
    void request.done.then(() => settling.delete(request.done));
  };

  return {
    async describe(r) {
      // Without a workspace the read below answers no_workspace_open.
      if (blocked && deps.manager.current() !== null) return { ok: false, code: 'cancelled' };
      if (active !== null) return { ok: false, code: 'busy' };
      const controller = new AbortController();
      const { signal } = controller;
      const run = deps.manager.read((session) =>
        describeImage({ session, vision: () => deps.vision(r.providerId), images: deps.images }, { fileId: r.fileId, model: r.model, prompt: r.prompt, signal }),
      );
      const request: ActiveRequest = { requestId: r.requestId, controller, done: run.then(() => {}, () => {}) };
      active = request;
      try {
        const text = await run;
        // Each request has its own signal, so a cancelled run's result never answers another request.
        return signal.aborted ? { ok: false, code: 'cancelled' } : { ok: true, text };
      } catch (error) {
        if (signal.aborted) return { ok: false, code: 'cancelled' };
        if (error instanceof JobError) return { ok: false, code: error.code };
        throw error;
      } finally {
        if (active === request) active = null;
      }
    },

    cancel(requestId) {
      if (active?.requestId === requestId) abort(active);
    },

    async cancelAll() {
      if (active !== null) abort(active);
      await Promise.all([...settling]);
    },

    block() {
      blocked = true;
    },

    unblock() {
      blocked = false;
    },
  };
}
