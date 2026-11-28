import {
  FileDownloadPayloadSchema,
  type FileDownloadPayload,
  type FileTarget,
  type ImportResult,
  type JobErrorCode,
  type JobResult,
  type SiteFilter,
} from '@assetforge/contracts';
import { relocateFile } from './asset-files.js';
import { NotFoundError } from './errors.js';
import { streamFailure } from './download-errors.js';
import { downloadBaseName, downloadFileName, isWebPage } from './download-name.js';
import { openRemote, siteLoginOf } from './download-open.js';
import { streamImportContextOf } from './import-context.js';
import { importStream, type ImportContext } from './import-file.js';
import { isRefusedImportName } from './import-refusals.js';
import { JobError, reportEffect, type Job, type JobEffects, type JobHandler } from './job-types.js';
import { fileKind } from './media-types.js';
import type { RemoteFile, RemoteFileSource } from './ports/remote-files.js';
import type { SiteAccess } from './ports/site-access.js';
import type { WorkspaceSession } from './session.js';
import { DOWNLOAD_FREE_SPACE_RESERVE } from './download-limits.js';

/** What the `file.download` job needs. */
export interface FileDownloadHandlerDependencies {
  /** The open workspace the file is imported into. */
  session: WorkspaceSession;
  /** The plain network source. */
  remote: RemoteFileSource;
  /** Told where a downloaded file was added; never for one that was already present. */
  effects?: JobEffects;
  /** The logins of the site profiles; without it every site download (payload v2) fails `download_profile_missing`. */
  sites?: SiteAccess;
}

/** The first error the source stream failed with; null while it failed with none. */
interface StreamErrors {
  first: unknown;
}

/**
 * The `file.download` job of the URL import: fetches the URL through `remote` and hands the body to the import
 * steps, with the URL as the file's origin. A download that does not end in a complete file leaves no file row.
 * With `skipDuplicates` a content that is already there is not stored again; the oldest such file takes the URL
 * as a further origin. Placing a new file in the target asset is best effort and leaves it in the inbox when it
 * fails. Nothing here logs the URL or puts it, a path or a cause message into an error.
 *
 * @param dependencies the workspace, the network source, and the optional effects and site logins
 * @returns the job handler
 */
export function createFileDownloadHandler(dependencies: FileDownloadHandlerDependencies): JobHandler {
  // A download hands its body as a stream and never opens a source file.
  const context = streamImportContextOf(dependencies.session);
  return {
    resourceClass: 'io',
    onInterrupted: 'requeue',
    run(job: Job, signal: AbortSignal): Promise<void> {
      return runDownload(dependencies, context, job, signal);
    },
  };
}

/**
 * Runs one download and turns whatever it throws into what the scheduler expects.
 *
 * @param dependencies the handler's dependencies
 * @param context the import context
 * @param job the download job
 * @param signal aborts the download
 * @returns resolves once the job's outcome is recorded; rejects with the abort reason once `signal` aborted, else
 *   with a `JobError`
 */
async function runDownload(
  dependencies: FileDownloadHandlerDependencies,
  context: ImportContext,
  job: Job,
  signal: AbortSignal,
): Promise<void> {
  try {
    await download(dependencies, context, job, signal);
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof JobError) throw error;
    // Unexpected: no cause, since its message could hold the URL and the scheduler logs a foreign error.
    throw new JobError('internal_error');
  }
}

/**
 * The steps of one download: the site login, the check for a file that already has the URL, opening the URL,
 * the checks of the answer, the import and the placement of the new file.
 *
 * @param dependencies the handler's dependencies
 * @param context the import context
 * @param job the download job
 * @param signal aborts the download
 * @returns resolves once the job's outcome is recorded
 */
async function download(
  dependencies: FileDownloadHandlerDependencies,
  context: ImportContext,
  job: Job,
  signal: AbortSignal,
): Promise<void> {
  const { session } = dependencies;
  const payload = parsePayload(job);
  // A site download goes out with its profile's login and keeps only what passes the profile's filter.
  const login = payload.v === 2 ? await siteLoginOf(dependencies.sites, payload.siteProfileId) : null;
  const filter = payload.v === 2 ? payload.filter : null;

  const present = await session.database.fileOrigins.findCompleteFileByUrl(payload.url);
  if (present !== null) {
    await setOutcome(session, job, present, 'already_present');
    return;
  }

  await requireSpace(session, 0);
  signal.throwIfAborted();
  const remote = await openRemote(dependencies.remote, login, payload.url, signal);
  // The stream is ours from here. Listen before any await: an adapter that destroys it with an error (cancel,
  // lost connection) must never find it without a listener, which would be an uncaught error in the main process.
  const streamErrors = watchStreamErrors(remote);
  if (signal.aborted) {
    remote.stream.destroy();
    signal.throwIfAborted();
  }
  const name = acceptedName(remote);
  const filtered = filter === null ? null : filterResultOf(filter, name, remote.contentLength);
  if (filtered !== null) {
    remote.stream.destroy();
    await setOutcome(session, job, null, filtered);
    return;
  }
  await requireSpaceFor(session, remote);
  throwIfFailedEarly(remote, streamErrors, signal);

  const { imported, isFilteredOut } = await importDownload(
    context,
    session,
    remote,
    name,
    payload,
    filter,
    streamErrors,
  );
  await recordImport(dependencies, job, payload, imported, isFilteredOut, streamErrors);
}

/**
 * The payload of a download job.
 *
 * @param job the download job
 * @returns the parsed payload; throws `internal_error` for one that does not parse
 */
function parsePayload(job: Job): FileDownloadPayload {
  const parsed = FileDownloadPayloadSchema.safeParse(job.payload);
  if (!parsed.success) throw new JobError('internal_error');
  return parsed.data;
}

/**
 * Starts collecting the errors of the source stream.
 *
 * @param remote the opened file
 * @returns the state that holds the first error
 */
function watchStreamErrors(remote: RemoteFile): StreamErrors {
  const streamErrors: StreamErrors = { first: null };
  remote.stream.on('error', (error: unknown) => {
    streamErrors.first ??= error;
  });
  return streamErrors;
}

/**
 * Ends the download with a job error, destroying its stream first.
 *
 * @param remote the opened file
 * @param code the job error code
 * @returns never; always throws the job error
 */
function refuse(remote: RemoteFile, code: JobErrorCode): never {
  remote.stream.destroy();
  throw new JobError(code);
}

/**
 * The file name of the download, after the checks of what the answer is.
 *
 * @param remote the opened file
 * @returns the file name; throws `download_not_a_file` for a web page and `download_type_refused` for a refused
 *   type, after destroying the stream
 */
function acceptedName(remote: RemoteFile): string {
  if (isWebPage(remote.contentType)) refuse(remote, 'download_not_a_file');
  const name = downloadFileName(remote);
  if (isRefusedImportName(downloadBaseName(remote)) || isRefusedImportName(name))
    refuse(remote, 'download_type_refused');
  return name;
}

/**
 * What the profile's filter leaves out before the body is read. The kind wins over the size: it is known for
 * certain, an announced length may be wrong.
 *
 * @param filter the filter of the site profile
 * @param name the file name of the download
 * @param contentLength the announced length; null when unknown
 * @returns `filtered_kind`, `filtered_size`, or null when the download passes for now
 */
function filterResultOf(filter: SiteFilter, name: string, contentLength: number | null): JobResult | null {
  if (!filter.kinds.includes(fileKind(name))) return 'filtered_kind';
  if (contentLength !== null && contentLength < filter.minBytes) return 'filtered_size';
  return null;
}

/**
 * Refuses when the storage reports too little free space for the reserve plus `length`.
 *
 * @param session the open workspace
 * @param length the bytes still to be written
 * @returns resolves when there is room; throws `download_no_space` otherwise
 */
async function requireSpace(session: WorkspaceSession, length: number): Promise<void> {
  const free = await session.storage.freeBytes();
  if (free !== null && free <= DOWNLOAD_FREE_SPACE_RESERVE + length) throw new JobError('download_no_space');
}

/**
 * Refuses when the storage has too little room for the announced length; destroys the stream then.
 *
 * @param session the open workspace
 * @param remote the opened file
 * @returns resolves when there is room; rejects with the failure of the check otherwise
 */
async function requireSpaceFor(session: WorkspaceSession, remote: RemoteFile): Promise<void> {
  try {
    await requireSpace(session, remote.contentLength ?? 0);
  } catch (error) {
    remote.stream.destroy();
    throw error;
  }
}

/**
 * Ends the download when the stream failed or the job was aborted while the space was checked; `run` turns the
 * failure into the abort when the signal fired.
 *
 * @param remote the opened file
 * @param streamErrors the errors of the stream so far
 * @param signal the job's abort signal
 */
function throwIfFailedEarly(remote: RemoteFile, streamErrors: StreamErrors, signal: AbortSignal): void {
  const early = streamErrors.first ?? remote.stream.errored;
  if (early == null && !signal.aborted) return;
  remote.stream.destroy();
  signal.throwIfAborted();
  throw streamFailure(early);
}

/**
 * Hands the body to the import steps. An unknown length is checked once the body is staged against the filter's
 * minimum size; the import then discards it and leaves no file row.
 *
 * @param context the import context
 * @param session the open workspace
 * @param remote the opened file
 * @param name the file name
 * @param payload the job's payload
 * @param filter the profile's filter; null for a plain download
 * @param streamErrors collects the stream error the import reports
 * @returns the import's result, and whether the minimum size left the body out
 */
async function importDownload(
  context: ImportContext,
  session: WorkspaceSession,
  remote: RemoteFile,
  name: string,
  payload: FileDownloadPayload,
  filter: SiteFilter | null,
  streamErrors: StreamErrors,
): Promise<{ imported: ImportResult; isFilteredOut: boolean }> {
  let isFilteredOut = false;
  const minBytes = filter?.minBytes ?? 0;
  const imported = await importStream(
    context,
    { sourcePath: '', entryName: null, name, stream: remote.stream },
    {
      origin: { id: session.newId(), url: payload.url },
      skipDuplicate: payload.skipDuplicates,
      discardOnFailure: true,
      ...(minBytes > 0
        ? {
            keepStaged: ({ sizeBytes }: { sizeBytes: number }) => {
              isFilteredOut = sizeBytes < minBytes;
              return !isFilteredOut;
            },
          }
        : {}),
      onStreamError: (error) => {
        streamErrors.first ??= error;
      },
    },
  );
  return { imported, isFilteredOut };
}

/**
 * Records what the import produced: a body left out by size, a duplicate that takes the URL as a further origin,
 * or the new file, which is then placed in the target asset.
 *
 * @param dependencies the handler's dependencies
 * @param job the download job
 * @param payload the job's payload
 * @param imported the import's result
 * @param isFilteredOut whether the minimum size left the body out
 * @param streamErrors the errors of the stream
 * @returns resolves once the outcome is recorded; throws the stream's job error when no complete file came of it
 */
async function recordImport(
  dependencies: FileDownloadHandlerDependencies,
  job: Job,
  payload: FileDownloadPayload,
  imported: ImportResult,
  isFilteredOut: boolean,
  streamErrors: StreamErrors,
): Promise<void> {
  const { session } = dependencies;
  // On a cancel or a stop the failed import has already discarded what it wrote; `run` turns the failure below
  // into the abort. A complete file is kept and recorded even then.
  const isWithoutFile = imported.file === null && imported.error === null;
  if (isFilteredOut && isWithoutFile) {
    await setOutcome(session, job, null, 'filtered_size');
    return;
  }
  const existing = isWithoutFile ? imported.duplicateOf[0] : undefined;
  if (existing !== undefined) {
    await addOriginToDuplicate(session, existing, payload.url);
    await setOutcome(session, job, existing, 'already_present');
    return;
  }
  const file = imported.file;
  if (imported.error !== null || file === null || file.status !== 'complete') {
    throw streamFailure(streamErrors.first);
  }

  // Nothing after this point fails the run: a later retry would keep a stale outcome.
  await setOutcome(session, job, file.id, null);
  await placeNewFile(dependencies, file.id, payload.target);
}

/**
 * Adds the URL as a further origin of the duplicate; a file already carrying this URL or MAX_FILE_ORIGINS keeps
 * its origins, and the job still points at it.
 *
 * @param session the open workspace
 * @param fileId the duplicate
 * @param url the downloaded address
 * @returns resolves once the origin is written or refused; throws `download_duplicate_gone` when the duplicate was
 *   purged since the import step named it
 */
async function addOriginToDuplicate(session: WorkspaceSession, fileId: string, url: string): Promise<void> {
  try {
    await session.database.fileOrigins.insert({
      id: session.newId(),
      fileId,
      url,
      createdAt: session.now().toISOString(),
    });
  } catch (error) {
    if (error instanceof NotFoundError) throw new JobError('download_duplicate_gone');
    throw error;
  }
}

/**
 * Moves a new file into the target asset, best effort, and reports where it was added.
 *
 * @param dependencies supplies the workspace and the effects
 * @param fileId the new file
 * @param target the asset and role; null leaves the file in the inbox
 * @returns resolves once the effects are reported; never rejects
 */
async function placeNewFile(
  dependencies: FileDownloadHandlerDependencies,
  fileId: string,
  target: FileTarget | null,
): Promise<void> {
  let placedIn: string | null = null;
  if (target !== null) {
    try {
      placedIn = (await relocateFile(dependencies.session, fileId, target)).assetId;
    } catch {
      // Best effort: the file stays in the inbox.
    }
  }
  reportEffect(dependencies.effects, (effects) => effects.fileAdded(placedIn));
  // The file passed through the inbox, so an inbox page read meanwhile may still hold it.
  if (placedIn !== null) reportEffect(dependencies.effects, (effects) => effects.fileAdded(null));
}

/**
 * Records what the job produced. False only when the job is no longer running, which is not a failure.
 *
 * @param session the open workspace
 * @param job the download job
 * @param fileId the file the job points at; null for none
 * @param result what it produced besides the file; null on an ordinary result
 * @returns whether the job was still running
 */
function setOutcome(
  session: WorkspaceSession,
  job: Job,
  fileId: string | null,
  result: JobResult | null,
): Promise<boolean> {
  return session.database.jobs.setOutcome(job.id, { fileId, result, now: session.now().toISOString() });
}
