import { ANALYZE_FILE_JOB, normalizeTagName, type JobView, type ProposalView } from '@assetforge/contracts';
import { InvalidOperationError, NotFoundError } from './errors.js';
import { requireLiveFile, TRASHED_FILE_MESSAGE } from './file-trash.js';
import { jobViewOf } from './job-view.js';
import type { Proposal, ProposalAcceptance } from './ports/analysis-repositories.js';
import type { WorkspaceSession } from './session.js';

/** A proposal as it is read, with whether its file changed since. */
type StoredProposal = Proposal & { stale: boolean };

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
    job: job === null ? null : jobViewOf(job, { fileName: file?.originalName ?? null, generation: null, result: null }),
  };
}

/**
 * Applies the chosen tags of the file's proposal like an analysis in mode `apply` and records the
 * analysis. `names` must be a non-empty subset of the proposal's tags, compared normalised.
 *
 * @param session the open workspace
 * @param request the file, the creation time of the proposal the caller saw and the chosen tag names
 * @returns resolves once the tags are applied
 * @throws `NotFoundError` without a proposal; `InvalidOperationError` for a file in the trash (its proposal is
 *   kept), for a foreign or empty choice, for a stale proposal, which is deleted, and for a proposal other than the
 *   one the caller saw, which is kept
 */
export async function acceptProposal(
  session: WorkspaceSession,
  request: { fileId: string; createdAt: string; names: string[] },
): Promise<void> {
  const proposal = await session.database.analyses.getProposal(request.fileId);
  if (proposal === null) throw new NotFoundError('The file has no tag proposal');
  // A stale proposal, or one the caller did not see, is handed over with no tags, so the repository's trash and
  // stale checks answer before the choice is looked at.
  const unseen = proposal.stale || proposal.createdAt !== request.createdAt;
  const chosen = unseen ? new Set<string>() : await choiceOf(session, proposal, request);
  const outcome = await session.database.analyses.acceptProposal({
    fileId: request.fileId,
    sha256: proposal.sha256,
    createdAt: request.createdAt,
    tags: proposal.tags.filter((tag) => chosen.has(tag.name)).map((tag) => ({ ...tag, newId: session.newId() })),
    now: session.now().toISOString(),
  });
  refuseUnaccepted(outcome);
}

/**
 * The chosen names; a refused choice of a file in the trash answers the trash refusal instead, so the trash wins
 * as the repository's check would. A valid choice reads no file record: the repository checks the trash then.
 *
 * @param session the open workspace
 * @param proposal the stored proposal
 * @param request the file and the chosen tag names
 * @returns the distinct normalised names
 * @throws `InvalidOperationError` for a file in the trash, or for a foreign or empty choice
 */
async function choiceOf(
  session: WorkspaceSession,
  proposal: StoredProposal,
  request: { fileId: string; names: string[] },
): Promise<Set<string>> {
  try {
    return chosenNames(proposal, request.names);
  } catch (error) {
    const file = await session.database.files.get(request.fileId);
    if (file !== null && file.deletedAt !== null) throw new InvalidOperationError(TRASHED_FILE_MESSAGE);
    throw error;
  }
}

/**
 * Turns an acceptance that applied nothing into its error.
 *
 * @param outcome what the repository answered
 * @returns nothing for `accepted`
 * @throws `NotFoundError` for `missing`; `InvalidOperationError` for `trashed` and `stale`
 */
function refuseUnaccepted(outcome: ProposalAcceptance): void {
  if (outcome === 'missing') throw new NotFoundError('The file has no tag proposal');
  if (outcome === 'trashed') throw new InvalidOperationError(TRASHED_FILE_MESSAGE);
  if (outcome === 'stale') throw new InvalidOperationError('The tag proposal is out of date');
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
