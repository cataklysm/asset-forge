import { ANALYZE_FILE_JOB, normalizeTagName, type JobView, type ProposalView } from '@assetforge/contracts';
import { InvalidOperationError, NotFoundError } from './errors.js';
import { requireLiveFile } from './file-trash.js';
import type { Job } from './jobs.js';
import type { WorkspaceSession } from './session.js';

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
  };
}

/**
 * The file's waiting proposal and its active, otherwise latest, `vision.analyze_file` job; null for
 * what does not exist.
 */
export async function getProposal(
  s: WorkspaceSession,
  fileId: string,
): Promise<{ proposal: ProposalView | null; job: JobView | null }> {
  const stored = await s.database.analyses.getProposal(fileId);
  const job = await s.database.jobs.latestForFile(fileId, ANALYZE_FILE_JOB);
  const file = job === null ? null : await s.database.files.get(fileId);
  return {
    proposal:
      stored === null
        ? null
        : { model: stored.model, promptName: stored.promptName, createdAt: stored.createdAt, stale: stored.stale, tags: stored.tags },
    job: job === null ? null : viewOf(job, file?.originalName ?? null),
  };
}

/**
 * Applies the chosen tags of the file's proposal like an analysis in mode `apply` and records the
 * analysis. `names` must be a non-empty subset of the proposal's tags, compared normalised.
 * `not_found` without a proposal; `invalid_operation` for a foreign or empty choice and for a stale
 * proposal, which is deleted.
 */
export async function acceptProposal(s: WorkspaceSession, r: { fileId: string; names: string[] }): Promise<void> {
  const proposal = await s.database.analyses.getProposal(r.fileId);
  if (proposal === null) throw new NotFoundError('The file has no tag proposal');
  // Checked before the stale branch, so a trashed file keeps its proposal for a restore.
  const file = await s.database.files.get(r.fileId);
  if (file !== null) requireLiveFile(file);
  if (proposal.stale) {
    await s.database.analyses.discardProposal(r.fileId);
    throw new InvalidOperationError('The tag proposal is out of date');
  }
  const chosen = new Set<string>();
  for (const raw of r.names) {
    const name = normalizeTagName(raw);
    if (name === null || !proposal.tags.some((t) => t.name === name)) {
      throw new InvalidOperationError('Only tags of the proposal can be accepted');
    }
    chosen.add(name);
  }
  if (chosen.size === 0) throw new InvalidOperationError('Choose at least one tag of the proposal');
  const accepted = await s.database.analyses.acceptProposal({
    fileId: r.fileId,
    sha256: proposal.sha256,
    tags: proposal.tags.filter((t) => chosen.has(t.name)).map((t) => ({ ...t, newId: s.newId() })),
    now: s.now().toISOString(),
  });
  if (!accepted) throw new InvalidOperationError('The tag proposal is out of date');
}

/** Deletes the file's proposal; no-op without one. */
export async function discardProposal(s: WorkspaceSession, fileId: string): Promise<void> {
  await s.database.analyses.discardProposal(fileId);
}
