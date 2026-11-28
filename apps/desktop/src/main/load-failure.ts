// Kept free of Electron imports so the decision logic is unit-testable.

const ERR_ABORTED = -3;

/**
 * Whether a load error is a superseded navigation.
 *
 * @param error the error
 * @returns true for ERR_ABORTED
 */
function isAborted(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, errno } = error as { code?: unknown; errno?: unknown };
  return code === 'ERR_ABORTED' || errno === ERR_ABORTED;
}

/** Takes the outcomes of the initial load. */
export interface LoadFailureHandler {
  /**
   * The `loadURL` / `loadFile` promise rejected.
   *
   * @param error why
   */
  rejected(error: unknown): void;
  /**
   * The `did-fail-load` event fired.
   *
   * @param errorCode the Chromium error code
   * @param errorDescription its description
   * @param isMainFrame whether the main frame failed
   */
  didFailLoad(errorCode: number, errorDescription: string, isMainFrame: boolean): void;
  /** The initial load finished; later failures are no longer fatal. */
  finished(): void;
}

/**
 * Decides when a failed initial load is fatal. A superseded navigation (ERR_ABORTED, e.g. a
 * reload while the first load is still running) is not a failure. A real failure surfaces
 * through both the rejected promise and `did-fail-load`, but is reported only once.
 *
 * @param onFailure called once for a fatal failure
 * @returns the handler
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
