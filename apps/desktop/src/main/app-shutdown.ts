import type { WorkspaceManager } from '@assetforge/core';
import type { PreviewService } from '@assetforge/media';
import type { AnalysisServices } from './analysis-services.js';
import type { ElectronSiteSessions } from './site-sessions.js';

// The steps of quitting, free of Electron so they can be tested: the site windows close, a running import stops
// after the item in progress, the jobs stop, then the workspace and the preview service close.

/** What quitting closes. */
export interface ShutdownParts {
  /** The site windows and sessions. */
  siteSessions: Pick<ElectronSiteSessions, 'shutdown'>;
  /** The workspace manager. */
  manager: Pick<WorkspaceManager, 'cancelImport' | 'close'>;
  /** The analysis services and the job host. */
  services: Pick<AnalysisServices, 'workspaceClosing'>;
  /** The preview service and its worker pool. */
  previews: Pick<PreviewService, 'close'>;
  /** Reports a failed step. */
  logError: (message: string, error: unknown) => void;
}

/**
 * Closes everything quitting must close, in order. Never rejects.
 *
 * @param parts what quitting closes
 * @returns resolves when every step was tried
 */
export async function closeApp(parts: ShutdownParts): Promise<void> {
  parts.siteSessions.shutdown();
  // The item in progress finishes; the queued close waits for it, the remaining sources give no result.
  parts.manager.cancelImport();
  try {
    // A describe request is cancelled and jobs stop before their database closes; workspaceClosing never rejects.
    await parts.services.workspaceClosing();
    await parts.manager.close();
  } catch (error) {
    parts.logError('Closing the workspace failed', error);
  }
  try {
    await parts.previews.close();
  } catch (error) {
    parts.logError('Closing the preview service failed', error);
  }
}
