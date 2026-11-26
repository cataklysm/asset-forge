import type { DescribeResult } from '@assetforge/contracts';
import { describeImage, JobError, type ModelImageSource, type VisionProvider, type WorkspaceManager } from '@assetforge/core';

// Image2Prompt requests: one at a time, cancellable by id, all cancelled when the workspace closes.
// Kept free of Electron imports. A provider failure answers its code; it is never logged here.

export interface DescribeController {
  /** `busy` while another request runs; `cancelled` once it was cancelled. Rejects with `no_workspace_open`. */
  describe(r: { requestId: string; fileId: string; model: string }): Promise<DescribeResult>;
  /** An unknown or finished request is left alone. */
  cancel(requestId: string): void;
  /** Cancels the running request and waits until it answered. Never rejects. */
  cancelAll(): Promise<void>;
}

interface ActiveRequest {
  requestId: string;
  controller: AbortController;
  done: Promise<unknown>;
}

export function createDescribeController(deps: {
  manager: WorkspaceManager;
  vision: () => VisionProvider | null;
  images: ModelImageSource;
}): DescribeController {
  let active: ActiveRequest | null = null;

  return {
    async describe(r) {
      if (active !== null) return { ok: false, code: 'busy' };
      const controller = new AbortController();
      const { signal } = controller;
      const run = deps.manager.read((session) =>
        describeImage({ session, vision: deps.vision, images: deps.images }, { fileId: r.fileId, model: r.model, signal }),
      );
      const request: ActiveRequest = { requestId: r.requestId, controller, done: run.catch(() => {}) };
      active = request;
      try {
        return { ok: true, text: await run };
      } catch (error) {
        if (signal.aborted) return { ok: false, code: 'cancelled' };
        if (error instanceof JobError) return { ok: false, code: error.code };
        throw error;
      } finally {
        if (active === request) active = null;
      }
    },

    cancel(requestId) {
      if (active?.requestId === requestId) active.controller.abort();
    },

    async cancelAll() {
      const running = active;
      if (running === null) return;
      running.controller.abort();
      await running.done;
    },
  };
}
