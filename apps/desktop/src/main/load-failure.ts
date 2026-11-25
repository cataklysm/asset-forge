// Kept free of Electron imports so the decision logic is unit-testable.

const ERR_ABORTED = -3;

function isAborted(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, errno } = error as { code?: unknown; errno?: unknown };
  return code === 'ERR_ABORTED' || errno === ERR_ABORTED;
}

export interface LoadFailureHandler {
  /** The `loadURL` / `loadFile` promise rejected. */
  rejected(error: unknown): void;
  /** The `did-fail-load` event fired. */
  didFailLoad(errorCode: number, errorDescription: string, isMainFrame: boolean): void;
  /** The initial load finished; later failures are no longer fatal. */
  finished(): void;
}

/**
 * Decides when a failed initial load is fatal. A superseded navigation (ERR_ABORTED, e.g. a
 * reload while the first load is still running) is not a failure. A real failure surfaces
 * through both the rejected promise and `did-fail-load`, but is reported only once.
 */
export function createLoadFailureHandler(onFailure: (error: unknown) => void): LoadFailureHandler {
  let done = false;
  const report = (error: unknown) => {
    if (done) return;
    done = true;
    onFailure(error);
  };
  return {
    rejected(error) {
      if (!isAborted(error)) report(error);
    },
    didFailLoad(errorCode, errorDescription, isMainFrame) {
      if (isMainFrame && errorCode !== ERR_ABORTED) {
        report(new Error(`Loading the app page failed: ${errorDescription} (${errorCode})`));
      }
    },
    finished() {
      done = true;
    },
  };
}
