import { BACKUP_QUIT_DEADLINE_MS } from '@assetforge/contracts';
import type { WorkspaceManager } from '@assetforge/core';
import type { PreviewService } from '@assetforge/media';
import type { AnalysisServices } from './analysis-services.js';
import type { RunningRestores } from './running-restores.js';
import type { ElectronSiteSessions } from './site-sessions.js';

// The steps of quitting, free of Electron so they can be tested: the site windows close, a running import stops
// after the item in progress and a running restore is aborted, the jobs stop, then the workspace closes with its
// final backup bounded by the quit deadline, the preview service closes, and the log file writes its last lines.

/** What quitting closes. */
export interface ShutdownParts {
  /** The site windows and sessions. */
  siteSessions: Pick<ElectronSiteSessions, 'shutdown'>;
  /** The workspace manager. */
  manager: Pick<WorkspaceManager, 'cancelImport' | 'close'>;
  /** The analysis services and the job host. */
  services: Pick<AnalysisServices, 'workspaceClosing'>;
  /** The restores in progress. */
  restores: Pick<RunningRestores, 'abortAll'>;
  /** The preview service and its worker pool. */
  previews: Pick<PreviewService, 'close'>;
  /** Reports a failed step. */
  logError: (message: string, error: unknown) => void;
  /** Writes the queued log lines, bounded by the log file's deadline; never rejects. */
  flushLog: () => Promise<void>;
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
  // The copy of a backup stops; a restore past its copy finishes in the queue before the close.
  parts.restores.abortAll();
  try {
    // A describe request is cancelled and jobs stop before their database closes; workspaceClosing never rejects.
    await parts.services.workspaceClosing();
    // The final backup is bounded, so a slow or unreachable backup folder never holds quitting up for long.
    await parts.manager.close({ backupDeadlineMs: BACKUP_QUIT_DEADLINE_MS });
  } catch (error) {
    parts.logError('Closing the workspace failed', error);
  }
  try {
    await parts.previews.close();
  } catch (error) {
    parts.logError('Closing the preview service failed', error);
  }
  // Last, so the lines of the steps above reach the log file; bounded, so quitting is never held up for long.
  await parts.flushLog();
}
