import {
  ANALYZE_FILE_JOB,
  type AnalysisMode,
  type AnalysisPreview,
  type AnalysisTarget,
  type AnalyzeFilePayload,
  type AnalyzeFilePrompt,
  type EnqueueAnalysisResult,
} from '@assetforge/contracts';
import { ANALYSIS_PROMPT_VERSION } from './analysis.js';
import { InvalidOperationError } from './errors.js';
import type { NewJob } from './jobs.js';
import { PREVIEWABLE_MIME_TYPES } from './media-types.js';
import type { AnalysisFingerprint, AnalysisTargetEntry } from './ports/analysis-repositories.js';
import type { WorkspaceSession } from './session.js';

/** Most jobs inserted by one `jobs.enqueue` call (one transaction), and the page size of the target. */
export const ENQUEUE_CHUNK = 500;

/** An enqueue of the analysis of a target. */
export interface EnqueueAnalysisRequest {
  /** The files to analyse. */
  target: AnalysisTarget;
  /** The model the jobs ask. */
  model: string;
  /** Whether the tags are applied or proposed. */
  mode: AnalysisMode;
  /** Whether files already analysed with this fingerprint are analysed again. */
  force: boolean;
  /** The adapter kind recorded in the fingerprint, never an entry id. */
  provider: string;
  /** The analysis prompt copied into every job. */
  prompt: AnalyzeFilePrompt;
  /** The provider entry the jobs run on. */
  entry: { id: string; name: string };
}

/** One page of the target as the repository answers it. */
type TargetPage = AnalysisTargetEntry[];

/**
 * The fingerprint an analysis with this provider and model leaves.
 *
 * @param request the adapter kind and the model
 * @returns the fingerprint with the current prompt version
 */
function fingerprintOf(request: { provider: string; model: string }): AnalysisFingerprint {
  return { provider: request.provider, model: request.model, promptVersion: ANALYSIS_PROMPT_VERSION };
}

/**
 * What an enqueue of the target with this model would do, by file count.
 *
 * @param session the open workspace
 * @param request the target, the model, the adapter kind and the provider entry
 * @returns the counts
 */
export async function previewAnalysis(
  session: WorkspaceSession,
  request: { target: AnalysisTarget; model: string; provider: string; entry: { id: string; name: string } },
): Promise<AnalysisPreview> {
  return session.database.analysisTargets.count({
    target: request.target,
    fingerprint: fingerprintOf(request),
    mimeTypes: PREVIEWABLE_MIME_TYPES,
  });
}

/**
 * One analysis job per analysable file of the target, read in keyset pages and inserted in chunks
 * of at most `ENQUEUE_CHUNK`. Not all or nothing: files that are unknown (listed ids only), not
 * analysable, already queued or — in mode `apply` without `force` — already analysed with this
 * fingerprint are counted as skipped. Mode `propose` takes exactly one listed file and implies `force`.
 * Every job runs in the lane of the provider entry and carries payload v4 with a copy of `prompt` and of the entry name.
 *
 * @param session the open workspace
 * @param request the target, the model, the mode, `force`, the adapter kind, the prompt and the provider entry
 * @returns how many jobs were queued and why the other files were skipped
 * @throws `InvalidOperationError` for a proposal of anything but one listed file
 */
export async function enqueueAnalysis(
  session: WorkspaceSession,
  request: EnqueueAnalysisRequest,
): Promise<EnqueueAnalysisResult> {
  const { target } = request;
  if (request.mode === 'propose' && !(target.kind === 'files' && target.fileIds.length === 1)) {
    throw new InvalidOperationError('A tag proposal can only be requested for a single file');
  }
  const skipAnalysed = request.mode === 'apply' && !request.force;
  const payload = payloadOf(request);
  const fingerprint = fingerprintOf(request);
  const result: EnqueueAnalysisResult = {
    enqueued: 0,
    skipped: { notFound: 0, notAnalysable: 0, alreadyQueued: 0, alreadyAnalysed: 0 },
  };
  let seen = 0;
  let afterId: string | null = null;
  for (;;) {
    const page: TargetPage = await session.database.analysisTargets.page({
      target,
      fingerprint,
      mimeTypes: PREVIEWABLE_MIME_TYPES,
      afterId,
      limit: ENQUEUE_CHUNK,
    });
    seen += page.length;
    const jobs = jobsOfPage(session, page, request.entry.id, payload, skipAnalysed, result);
    await insertJobs(session, jobs, result);
    if (page.length < ENQUEUE_CHUNK) break;
    afterId = page[page.length - 1]!.fileId;
  }
  if (target.kind === 'files') result.skipped.notFound = Math.max(new Set(target.fileIds).size - seen, 0);
  return result;
}

/**
 * The payload every job of an enqueue carries.
 *
 * @param request the enqueue
 * @returns a v4 payload with copies of the prompt and the entry name
 */
function payloadOf(request: EnqueueAnalysisRequest): AnalyzeFilePayload {
  // The prompt is copied into every job, so later edits or a deletion do not reach waiting jobs.
  // It is not part of the fingerprint: a file analysed with another prompt still counts as analysed.
  const prompt: AnalyzeFilePrompt = { name: request.prompt.name, text: request.prompt.text, maxTags: request.prompt.maxTags };
  return { version: 4, model: request.model, mode: request.mode, prompt, providerName: request.entry.name };
}

/**
 * The jobs of one page; the files that are skipped are counted in `result`.
 *
 * @param session the open workspace
 * @param page the page of the target
 * @param lane the provider entry the jobs run on
 * @param payload the payload of every job
 * @param skipAnalysed whether files already analysed with the fingerprint are skipped
 * @param result the running counts, updated in place
 * @returns the new jobs, in page order
 */
function jobsOfPage(
  session: WorkspaceSession,
  page: TargetPage,
  lane: string,
  payload: AnalyzeFilePayload,
  skipAnalysed: boolean,
  result: EnqueueAnalysisResult,
): NewJob[] {
  const jobs: NewJob[] = [];
  for (const entry of page) {
    if (!entry.analysable) {
      result.skipped.notAnalysable++;
      continue;
    }
    if (skipAnalysed && entry.analysed) {
      result.skipped.alreadyAnalysed++;
      continue;
    }
    jobs.push({
      id: session.newId(),
      type: ANALYZE_FILE_JOB,
      resourceClass: 'local_gpu',
      fileId: entry.fileId,
      lane,
      payload,
      dedupeKey: `${ANALYZE_FILE_JOB}:${entry.fileId}`,
    });
  }
  return jobs;
}

/**
 * Inserts the jobs of one page in one call; a job whose file is already queued is counted as skipped.
 *
 * @param session the open workspace
 * @param jobs the jobs; nothing is written when there are none
 * @param result the running counts, updated in place
 * @returns resolves once the jobs are inserted
 */
async function insertJobs(session: WorkspaceSession, jobs: NewJob[], result: EnqueueAnalysisResult): Promise<void> {
  if (jobs.length === 0) return;
  const inserted = await session.database.jobs.enqueue({ jobs, now: session.now().toISOString() });
  result.enqueued += inserted.length;
  result.skipped.alreadyQueued += jobs.length - inserted.length;
}
