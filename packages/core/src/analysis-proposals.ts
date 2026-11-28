import {
  ANALYZE_FILE_JOB,
  analysisJobFields,
  normalizeTagName,
  type JobView,
  type ProposalView,
} from '@assetforge/contracts';
import { InvalidOperationError, NotFoundError } from './errors.js';
import { requireLiveFile } from './file-trash.js';
import type { Job } from './jobs.js';
import type { Proposal } from './ports/analysis-repositories.js';
import type { WorkspaceSession } from './session.js';

/** A proposal as it is read, with whether its file changed since. */
type StoredProposal = Proposal & { stale: boolean };

/**
 * The view of an analysis job.
 *
 * @param job the job
 * @param fileName the name of its file; null when it is gone
 * @returns the view with the analysis fields of its payload
 */
function viewOf(job: Job, fileName: string | null): JobView {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    attempt: job.attempt,
    fileId: job.fileId,
    fileName,
    errorCode: job.errorCode,
    errorMessage: job.errorMessage,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    runAfter: job.runAfter,
    providerId: job.lane,
    ...analysisJobFields(job.payload),
    url: null,
    host: null,
    result: null,
  };
}

/**
 * The view of a stored proposal.
 *
 * @param stored the stored proposal
 * @returns its model, prompt name, time, staleness and tags
 */
function proposalViewOf(stored: StoredProposal): ProposalView {
  return {
    model: stored.model,
    promptName: stored.promptName,
    createdAt: stored.createdAt,
    stale: stored.stale,
    tags: stored.tags,
  };
}

/**
 * The file's waiting proposal and its active, otherwise latest, `vision.analyze_file` job.
 *
 * @param session the open workspace
 * @param fileId the file
 * @returns the proposal and the job; null for what does not exist
 */
export async function getProposal(
  session: WorkspaceSession,
  fileId: string,
): Promise<{ proposal: ProposalView | null; job: JobView | null }> {
  const stored = await session.database.analyses.getProposal(fileId);
  const job = await session.database.jobs.latestForFile(fileId, ANALYZE_FILE_JOB);
  const file = job === null ? null : await session.database.files.get(fileId);
  return {
    proposal: stored === null ? null : proposalViewOf(stored),
    job: job === null ? null : viewOf(job, file?.originalName ?? null),
  };
}

/**
 * Applies the chosen tags of the file's proposal like an analysis in mode `apply` and records the
 * analysis. `names` must be a non-empty subset of the proposal's tags, compared normalised.
 *
 * @param session the open workspace
 * @param request the file and the chosen tag names
 * @returns resolves once the tags are applied
 * @throws `NotFoundError` without a proposal; `InvalidOperationError` for a foreign or empty choice and for a
 *   stale proposal, which is deleted
 */
export async function acceptProposal(
  session: WorkspaceSession,
  request: { fileId: string; names: string[] },
): Promise<void> {
  const proposal = await session.database.analyses.getProposal(request.fileId);
  if (proposal === null) throw new NotFoundError('The file has no tag proposal');
  // Checked before the stale branch, so a trashed file keeps its proposal for a restore.
  const file = await session.database.files.get(request.fileId);
  if (file !== null) requireLiveFile(file);
  if (proposal.stale) {
    await session.database.analyses.discardProposal(request.fileId);
    throw new InvalidOperationError('The tag proposal is out of date');
  }
  const chosen = chosenNames(proposal, request.names);
  const accepted = await session.database.analyses.acceptProposal({
    fileId: request.fileId,
    sha256: proposal.sha256,
    tags: proposal.tags.filter((tag) => chosen.has(tag.name)).map((tag) => ({ ...tag, newId: session.newId() })),
    now: session.now().toISOString(),
  });
  if (!accepted) throw new InvalidOperationError('The tag proposal is out of date');
}

/**
 * The normalised names of a choice of proposal tags.
 *
 * @param proposal the stored proposal
 * @param names the chosen names as typed
 * @returns the distinct normalised names
 * @throws `InvalidOperationError` for a name that is not a tag of the proposal, or for an empty choice
 */
function chosenNames(proposal: StoredProposal, names: string[]): Set<string> {
  const chosen = new Set<string>();
  for (const raw of names) {
    const name = normalizeTagName(raw);
    if (name === null || !proposal.tags.some((tag) => tag.name === name)) {
      throw new InvalidOperationError('Only tags of the proposal can be accepted');
    }
    chosen.add(name);
  }
  if (chosen.size === 0) throw new InvalidOperationError('Choose at least one tag of the proposal');
  return chosen;
}

/**
 * Deletes the file's proposal; no-op without one. A trashed file keeps its proposal for a restore.
 *
 * @param session the open workspace
 * @param fileId the file
 * @returns resolves once it is deleted
 * @throws `InvalidOperationError` for a file in the trash
 */
export async function discardProposal(session: WorkspaceSession, fileId: string): Promise<void> {
  const file = await session.database.files.get(fileId);
  if (file !== null) requireLiveFile(file);
  await session.database.analyses.discardProposal(fileId);
}
