import { belongsToSite, FileDownloadPayloadSchema, type JobErrorCode, type JobResult } from '@assetforge/contracts';
import { relocateFile } from './asset-files.js';
import { downloadBaseName, downloadFileName, isWebPage } from './download-name.js';
import { SourceNotReadableError } from './errors.js';
import { importStream, isRefusedImportName, type ImportContext } from './import-file.js';
import { JobError, reportEffect, type Job, type JobEffects, type JobHandler } from './jobs.js';
import { fileKind } from './media-types.js';
import {
  RemoteFileError,
  type RemoteFile,
  type RemoteFileFailure,
  type RemoteFileSource,
  type RemoteOpenOptions,
  type SiteAccess,
} from './ports.js';
import type { WorkspaceSession } from './session.js';
import { clampRetryAfterMs, DOWNLOAD_FREE_SPACE_RESERVE } from './url-import.js';

export interface FileDownloadHandlerDeps {
  session: WorkspaceSession;
  remote: RemoteFileSource;
  /** Told where a downloaded file was added; never for one that was already present. */
  effects?: JobEffects;
  /** The logins of the site profiles; without it every site download (payload v2) fails `download_profile_missing`. */
  sites?: SiteAccess;
}

const FAILURE_CODES: Readonly<Record<RemoteFileFailure, JobErrorCode>> = {
  challenge: 'download_browser_check',
  unreachable: 'download_unreachable',
  unavailable: 'download_unavailable',
  throttled: 'download_throttled',
  blocked: 'download_blocked',
  not_found: 'download_not_found',
  rejected: 'download_rejected',
  address_refused: 'download_address_refused',
  too_large: 'download_too_large',
};

/**
 * The job error code of a source failure. A refusal names its HTTP status where that tells the user what to do:
 * 401 means the login is missing or expired, 403 that the server will not hand the file to this request.
 *
 * @param error the failure of the remote source
 * @returns the code stored on the job
 */
function codeOf(error: RemoteFileError): JobErrorCode {
  if (error.failure === 'blocked' && error.status === 401) return 'download_unauthorized';
  if (error.failure === 'blocked' && error.status === 403) return 'download_forbidden';
  return FAILURE_CODES[error.failure];
}

/** The job error of a source failure; only a throttled one carries a wait, and always one. No cause: it could hold the URL. */
function jobErrorOf(error: RemoteFileError): JobError {
  const retryAfterMs = error.failure === 'throttled' ? clampRetryAfterMs(error.retryAfterMs) : null;
  return new JobError(codeOf(error), { retryAfterMs });
}

/** The job error of whatever ended the source stream: a source failure keeps its code, anything else is internal. */
function streamFailure(error: unknown): JobError {
  return error instanceof RemoteFileError ? jobErrorOf(error) : new JobError('internal_error');
}

/**
 * Opens a site download: through the profile's browser session when `viaSession` names one, else through the
 * plain remote source.
 *
 * @param remote the plain network source
 * @param viaSession the site access with a session and the profile to use; null for the plain source
 * @param url the address of the file
 * @param signal aborts the request
 * @param options the per-hop headers of the profile's login
 * @returns the opened remote file
 */
function openWith(
  remote: RemoteFileSource,
  viaSession: { sites: SiteAccess; profileId: string } | null,
  url: string,
  signal: AbortSignal,
  options: RemoteOpenOptions,
): Promise<RemoteFile> {
  const open = viaSession?.sites.open;
  return viaSession !== null && open !== undefined
    ? open.call(viaSession.sites, viaSession.profileId, url, signal, options)
    : remote.open(url, signal, options);
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
  const setOutcome = (job: Job, fileId: string | null, result: JobResult | null) =>
    s.database.jobs.setOutcome(job.id, { fileId, result, now: s.now().toISOString() });

  /** Refuses when the storage reports too little free space for the reserve plus `length`. */
  async function requireSpace(length: number): Promise<void> {
    const free = await s.storage.freeBytes();
    if (free !== null && free <= DOWNLOAD_FREE_SPACE_RESERVE + length) throw new JobError('download_no_space');
  }

  async function download(job: Job, signal: AbortSignal): Promise<void> {
    const parsed = FileDownloadPayloadSchema.safeParse(job.payload);
    if (!parsed.success) throw new JobError('internal_error');
    const payload = parsed.data;
    const { url, target, skipDuplicates } = payload;

    // A site download goes out with its profile's login and keeps only what passes the profile's filter.
    let openOptions: RemoteOpenOptions | undefined;
    /** The profile whose browser session opens a v2 job's URL; null where no session exists, and for v1. */
    let viaSession: { sites: SiteAccess; profileId: string } | null = null;
    const filter = payload.v === 2 ? payload.filter : null;
    // Whether the hop asked last went out without the login because it left the profile's site.
    let lastHopOffSite = false;
    if (payload.v === 2) {
      const sites = deps.sites;
      const profileId = payload.siteProfileId;
      const profileSite = sites === undefined ? null : await sites.siteOf(profileId);
      if (sites === undefined || profileSite === null) throw new JobError('download_profile_missing');
      openOptions = {
        headersFor: async (hopUrl) => {
          const headers = await sites.headersFor(profileId, hopUrl);
          lastHopOffSite = !belongsToSite(hopUrl, profileSite);
          return headers;
        },
      };
      if (sites.open !== undefined) viaSession = { sites, profileId };
    }

    const present = await s.database.fileOrigins.findCompleteFileByUrl(url);
    if (present !== null) {
      await setOutcome(job, present, 'already_present');
      return;
    }

    await requireSpace(0);
    signal.throwIfAborted();
    let remote: RemoteFile;
    try {
      remote =
        openOptions === undefined
          ? await deps.remote.open(url, signal)
          : await openWith(deps.remote, viaSession, url, signal, openOptions);
    } catch (error) {
      if (error instanceof RemoteFileError) {
        // A refusal of a hop that went out without the login: the login was the likely miss, not the address.
        if (error.failure === 'blocked' && lastHopOffSite) throw new JobError('download_login_not_sent');
        throw jobErrorOf(error);
      }
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
    if (filter !== null) {
      // The kind wins over the size: it is known for certain, an announced length may be wrong.
      const filtered: JobResult | null = !filter.kinds.includes(fileKind(name))
        ? 'filtered_kind'
        : remote.contentLength !== null && remote.contentLength < filter.minBytes
          ? 'filtered_size'
          : null;
      if (filtered !== null) {
        remote.stream.destroy();
        await setOutcome(job, null, filtered);
        return;
      }
    }
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

    // An unknown length is checked once the body is staged; the import then discards it and leaves no file row.
    let filteredOut = false;
    const minBytes = filter?.minBytes ?? 0;
    const imported = await importStream(
      ctx,
      { sourcePath: '', entryName: null, name, stream: remote.stream },
      {
        origin: { id: s.newId(), url },
        skipDuplicate: skipDuplicates,
        discardOnFailure: true,
        ...(minBytes > 0
          ? {
              keepStaged: ({ sizeBytes }: { sizeBytes: number }) => {
                filteredOut = sizeBytes < minBytes;
                return !filteredOut;
              },
            }
          : {}),
        onStreamError: (error) => {
          streamError ??= error;
        },
      },
    );
    // On a cancel or a stop the failed import has already discarded what it wrote; `run` turns the failure below
    // into the abort. A complete file is kept and recorded even then.
    if (filteredOut && imported.file === null && imported.error === null) {
      await setOutcome(job, null, 'filtered_size');
      return;
    }
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
