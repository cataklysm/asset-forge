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
import type { AnalysisFingerprint } from './ports.js';
import type { WorkspaceSession } from './session.js';

/** Most jobs inserted by one `jobs.enqueue` call (one transaction), and the page size of the target. */
export const ENQUEUE_CHUNK = 500;

function fingerprintOf(r: { provider: string; model: string }): AnalysisFingerprint {
  return { provider: r.provider, model: r.model, promptVersion: ANALYSIS_PROMPT_VERSION };
}

/** What an enqueue of the target with this model would do, by file count. */
export async function previewAnalysis(
  s: WorkspaceSession,
  r: { target: AnalysisTarget; model: string; provider: string },
): Promise<AnalysisPreview> {
  return s.database.analysisTargets.count({ target: r.target, fingerprint: fingerprintOf(r), mimeTypes: PREVIEWABLE_MIME_TYPES });
}

/**
 * One analysis job per analysable file of the target, read in keyset pages and inserted in chunks
 * of at most `ENQUEUE_CHUNK`. Not all or nothing: files that are unknown (listed ids only), not
 * analysable, already queued or — in mode `apply` without `force` — already analysed with this
 * fingerprint are counted as skipped. Mode `propose` takes exactly one listed file and implies `force`.
 * Every job carries payload v3 with a copy of `prompt`.
 */
export async function enqueueAnalysis(
  s: WorkspaceSession,
  r: { target: AnalysisTarget; model: string; mode: AnalysisMode; force: boolean; provider: string; prompt: AnalyzeFilePrompt },
): Promise<EnqueueAnalysisResult> {
  const { target } = r;
  if (r.mode === 'propose' && !(target.kind === 'files' && target.fileIds.length === 1)) {
    throw new InvalidOperationError('A tag proposal can only be requested for a single file');
  }
  const skipAnalysed = r.mode === 'apply' && !r.force;
  // The prompt is copied into every job, so later edits or a deletion do not reach waiting jobs.
  // It is not part of the fingerprint: a file analysed with another prompt still counts as analysed.
  const prompt: AnalyzeFilePrompt = { name: r.prompt.name, text: r.prompt.text, maxTags: r.prompt.maxTags };
  const payload: AnalyzeFilePayload = { version: 3, model: r.model, mode: r.mode, prompt };
  const fingerprint = fingerprintOf(r);
  const result: EnqueueAnalysisResult = {
    enqueued: 0,
    skipped: { notFound: 0, notAnalysable: 0, alreadyQueued: 0, alreadyAnalysed: 0 },
  };
  let seen = 0;
  let afterId: string | null = null;
  for (;;) {
    const page = await s.database.analysisTargets.page({
      target,
      fingerprint,
      mimeTypes: PREVIEWABLE_MIME_TYPES,
      afterId,
      limit: ENQUEUE_CHUNK,
    });
    seen += page.length;
    const jobs: NewJob[] = [];
    for (const entry of page) {
      if (!entry.analysable) result.skipped.notAnalysable++;
      else if (skipAnalysed && entry.analysed) result.skipped.alreadyAnalysed++;
      else {
        jobs.push({
          id: s.newId(),
          type: ANALYZE_FILE_JOB,
          resourceClass: 'local_gpu',
          fileId: entry.fileId,
          payload,
          dedupeKey: `${ANALYZE_FILE_JOB}:${entry.fileId}`,
        });
      }
    }
    if (jobs.length > 0) {
      const inserted = await s.database.jobs.enqueue({ jobs, now: s.now().toISOString() });
      result.enqueued += inserted.length;
      result.skipped.alreadyQueued += jobs.length - inserted.length;
    }
    if (page.length < ENQUEUE_CHUNK) break;
    afterId = page[page.length - 1]!.fileId;
  }
  if (target.kind === 'files') result.skipped.notFound = Math.max(new Set(target.fileIds).size - seen, 0);
  return result;
}
