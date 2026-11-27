import { FileDownloadPayloadSchema, type JobErrorCode, type JobResult } from '@assetforge/contracts';
import { relocateFile } from './asset-files.js';
import { downloadBaseName, downloadFileName, isWebPage } from './download-name.js';
import { SourceNotReadableError } from './errors.js';
import { importStream, isRefusedImportName, type ImportContext } from './import-file.js';
import { JobError, reportEffect, type Job, type JobEffects, type JobHandler } from './jobs.js';
import { RemoteFileError, type RemoteFile, type RemoteFileFailure, type RemoteFileSource } from './ports.js';
import type { WorkspaceSession } from './session.js';
import { clampRetryAfterMs, DOWNLOAD_FREE_SPACE_RESERVE } from './url-import.js';

export interface FileDownloadHandlerDeps {
  session: WorkspaceSession;
  remote: RemoteFileSource;
  /** Told where a downloaded file was added; never for one that was already present. */
  effects?: JobEffects;
}

const FAILURE_CODES: Readonly<Record<RemoteFileFailure, JobErrorCode>> = {
  unreachable: 'download_unreachable',
  unavailable: 'download_unavailable',
  throttled: 'download_throttled',
  blocked: 'download_blocked',
  not_found: 'download_not_found',
  rejected: 'download_rejected',
  address_refused: 'download_address_refused',
  too_large: 'download_too_large',
};

/** The job error of a source failure; only a throttled one carries a wait, and always one. No cause: it could hold the URL. */
function jobErrorOf(error: RemoteFileError): JobError {
  const retryAfterMs = error.failure === 'throttled' ? clampRetryAfterMs(error.retryAfterMs) : null;
  return new JobError(FAILURE_CODES[error.failure], { retryAfterMs });
}

/** The job error of whatever ended the source stream: a source failure keeps its code, anything else is internal. */
function streamFailure(error: unknown): JobError {
  return error instanceof RemoteFileError ? jobErrorOf(error) : new JobError('internal_error');
}

/**
 * The `file.download` job of the URL import: fetches the URL through `remote` and hands the body to the import
 * steps, with the URL as the file's origin. A download that does not end in a complete file leaves no file row.
 * With `skipDuplicates` a content that is already there is not stored again; the oldest such file takes the URL
 * as a further origin. Placing a new file in the target asset is best effort and leaves it in the inbox when it
 * fails. Nothing here logs the URL or puts it, a path or a cause message into an error.
 */
export function createFileDownloadHandler(deps: FileDownloadHandlerDeps): JobHandler {
  const s = deps.session;
  const ctx: ImportContext = {
    storage: s.storage,
    storageId: s.storageId,
    files: s.database.files,
    sources: { open: () => Promise.reject(new SourceNotReadableError()) },
    probe: s.imageProbe,
    newId: () => s.newId(),
    now: () => s.now(),
  };

  /** Records what the job produced. False only when the job is no longer running, which is not a failure. */
  const setOutcome = (job: Job, fileId: string, result: JobResult | null) =>
    s.database.jobs.setOutcome(job.id, { fileId, result, now: s.now().toISOString() });

  /** Refuses when the storage reports too little free space for the reserve plus `length`. */
  async function requireSpace(length: number): Promise<void> {
    const free = await s.storage.freeBytes();
    if (free !== null && free <= DOWNLOAD_FREE_SPACE_RESERVE + length) throw new JobError('download_no_space');
  }

  async function download(job: Job, signal: AbortSignal): Promise<void> {
    const parsed = FileDownloadPayloadSchema.safeParse(job.payload);
    if (!parsed.success) throw new JobError('internal_error');
    const { url, target, skipDuplicates } = parsed.data;

    const present = await s.database.fileOrigins.findCompleteFileByUrl(url);
    if (present !== null) {
      await setOutcome(job, present, 'already_present');
      return;
    }

    await requireSpace(0);
    signal.throwIfAborted();
    let remote: RemoteFile;
    try {
      remote = await deps.remote.open(url, signal);
    } catch (error) {
      if (error instanceof RemoteFileError) throw jobErrorOf(error);
      throw error;
    }
    // The stream is ours from here. Listen before any await: an adapter that destroys it with an error (cancel,
    // lost connection) must never find it without a listener, which would be an uncaught error in the main process.
    let streamError: unknown = null;
    remote.stream.on('error', (error: unknown) => {
      streamError ??= error;
    });
    const refuse = (code: JobErrorCode): never => {
      remote.stream.destroy();
      throw new JobError(code);
    };
    if (signal.aborted) {
      remote.stream.destroy();
      signal.throwIfAborted();
    }
    if (isWebPage(remote.contentType)) refuse('download_not_a_file');
    const name = downloadFileName(remote);
    if (isRefusedImportName(downloadBaseName(remote)) || isRefusedImportName(name)) refuse('download_type_refused');
    try {
      await requireSpace(remote.contentLength ?? 0);
    } catch (error) {
      remote.stream.destroy();
      throw error;
    }
    // A failure while the space was checked; `run` turns it into the abort when the signal fired.
    const early = streamError ?? remote.stream.errored;
    if (early != null || signal.aborted) {
      remote.stream.destroy();
      signal.throwIfAborted();
      throw streamFailure(early);
    }

    const imported = await importStream(
      ctx,
      { sourcePath: '', entryName: null, name, stream: remote.stream },
      {
        origin: { id: s.newId(), url },
        skipDuplicate: skipDuplicates,
        discardOnFailure: true,
        onStreamError: (error) => {
          streamError ??= error;
        },
      },
    );
    // On a cancel or a stop the failed import has already discarded what it wrote; `run` turns the failure below
    // into the abort. A complete file is kept and recorded even then.
    const existing = imported.file === null && imported.error === null ? imported.duplicateOf[0] : undefined;
    if (existing !== undefined) {
      // A file already carrying this URL or 50 origins answers false; the job still points at it.
      await s.database.fileOrigins.insert({ id: s.newId(), fileId: existing, url, createdAt: s.now().toISOString() });
      await setOutcome(job, existing, 'already_present');
      return;
    }
    const file = imported.file;
    if (imported.error !== null || file === null || file.status !== 'complete') {
      throw streamFailure(streamError);
    }

    // Nothing after this point fails the run: a later retry would keep a stale outcome.
    await setOutcome(job, file.id, null);
    let placedIn: string | null = null;
    if (target !== null) {
      try {
        placedIn = (await relocateFile(s, file.id, target)).assetId;
      } catch {
        // Best effort: the file stays in the inbox.
      }
    }
    reportEffect(deps.effects, (e) => e.fileAdded(placedIn));
    // The file passed through the inbox, so an inbox page read meanwhile may still hold it.
    if (placedIn !== null) reportEffect(deps.effects, (e) => e.fileAdded(null));
  }

  return {
    resourceClass: 'io',
    onInterrupted: 'requeue',

    async run(job: Job, signal: AbortSignal): Promise<void> {
      try {
        await download(job, signal);
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (error instanceof JobError) throw error;
        // Unexpected: no cause, since its message could hold the URL and the scheduler logs a foreign error.
        throw new JobError('internal_error');
      }
    },
  };
}
