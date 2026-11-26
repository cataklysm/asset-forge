import { describe, expect, test } from 'vitest';
import {
  ACTIVE_JOB_STATUSES,
  AnalyzeFilePayloadSchema,
  FINISHED_JOB_STATUSES,
  JOB_ERROR_MESSAGES,
  JobErrorCodeSchema,
  JobStatusSchema,
  JobSummarySchema,
  JobViewSchema,
  EnqueueAnalysisResultSchema,
  isRetryableJobError,
} from '../src/index';

const view = {
  id: 'j1',
  type: 'vision.analyze_file',
  status: 'queued',
  attempt: 0,
  fileId: null,
  fileName: null,
  errorCode: null,
  errorMessage: null,
  createdAt: '2026-11-26T10:00:00.000Z',
  startedAt: null,
  finishedAt: null,
  runAfter: null,
};

describe('job contracts', () => {
  test.each(JobErrorCodeSchema.options.map((c) => [c]))('%s has a message', (code) => {
    expect(JOB_ERROR_MESSAGES[code].length).toBeGreaterThan(0);
  });

  test('only transient provider errors are retryable', () => {
    const retryable = JobErrorCodeSchema.options.filter(isRetryableJobError);
    expect(retryable).toEqual(['provider_unreachable', 'provider_timeout', 'provider_unavailable', 'invalid_response']);
  });

  test('active and finished statuses cover all statuses', () => {
    expect([...ACTIVE_JOB_STATUSES, ...FINISHED_JOB_STATUSES].sort()).toEqual([...JobStatusSchema.options].sort());
  });

  test('a job view without a file is valid; an unknown status is not', () => {
    expect(JobViewSchema.safeParse(view).success).toBe(true);
    expect(JobViewSchema.safeParse({ ...view, status: 'paused' }).success).toBe(false);
  });

  test('the payload version is pinned', () => {
    expect(AnalyzeFilePayloadSchema.safeParse({ version: 1 }).success).toBe(true);
    expect(AnalyzeFilePayloadSchema.safeParse({ version: 2 }).success).toBe(false);
  });

  test('summary counts are non-negative integers', () => {
    const ok = { queued: 0, running: 1, waiting: 0, failed: 2, cancelled: 0, succeeded: 3, changes: 4 };
    expect(JobSummarySchema.safeParse(ok).success).toBe(true);
    expect(JobSummarySchema.safeParse({ ...ok, failed: -1 }).success).toBe(false);
  });

  test('an enqueue result lists skipped files with a reason', () => {
    expect(EnqueueAnalysisResultSchema.safeParse({ enqueued: 1, skipped: [{ fileId: 'f', reason: 'not_found' }] }).success).toBe(true);
    expect(EnqueueAnalysisResultSchema.safeParse({ enqueued: 1, skipped: [{ fileId: 'f', reason: 'x' }] }).success).toBe(false);
  });
});
