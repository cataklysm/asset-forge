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
  analysisJobFields,
  ipcContract,
  ProviderIdSchema,
  IMAGE_GENERATE_JOB,
  ImageGeneratePayloadSchema,
  PausedProviderSchema,
} from '../src/index';

const uuid = '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';

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
  providerId: null,
  providerName: null,
  model: null,
  url: null,
  host: null,
  result: null,
};

describe('job contracts', () => {
  test.each(JobErrorCodeSchema.options.map((c) => [c]))('%s has a message', (code) => {
    expect(JOB_ERROR_MESSAGES[code].length).toBeGreaterThan(0);
  });

  test('no job message mentions analysis', () => {
    for (const code of JobErrorCodeSchema.options)
      expect(JOB_ERROR_MESSAGES[code].toLowerCase()).not.toContain('analysis');
  });

  test('the generation codes and the neutral messages', () => {
    expect(JOB_ERROR_MESSAGES.provider_outcome_unknown).toBe(
      'The provider may have processed this request; it was not repeated',
    );
    expect(JOB_ERROR_MESSAGES.provider_insufficient_balance).toBe('The provider account has no balance left');
    expect(JOB_ERROR_MESSAGES.provider_content_refused).toBe('The provider refused this content');
    expect(JOB_ERROR_MESSAGES.provider_unreachable).toBe('The provider could not be reached');
    expect(JOB_ERROR_MESSAGES.file_unavailable).toBe('The file is not available');
    expect(JOB_ERROR_MESSAGES.provider_not_configured).toBe('No provider is configured');
    expect(JOB_ERROR_MESSAGES.internal_error).toBe('The job failed unexpectedly');
    expect(JOB_ERROR_MESSAGES.generation_result_not_stored).toBe(
      'The provider answered, but the result could not be stored',
    );
  });

  test('the generation codes are not retryable', () => {
    for (const code of [
      'provider_outcome_unknown',
      'provider_insufficient_balance',
      'provider_content_refused',
      'generation_result_not_stored',
    ] as const) {
      expect(isRetryableJobError(code)).toBe(false);
    }
  });

  test('the image generation job type and payload', () => {
    expect(IMAGE_GENERATE_JOB).toBe('image.generate');
    expect(ImageGeneratePayloadSchema.safeParse({ v: 1, generationId: uuid }).success).toBe(true);
    expect(ImageGeneratePayloadSchema.safeParse({ v: 2, generationId: uuid }).success).toBe(false);
    expect(ImageGeneratePayloadSchema.safeParse({ v: 1, generationId: 'x' }).success).toBe(false);
  });

  test('only transient provider and download errors are retryable', () => {
    const retryable = JobErrorCodeSchema.options.filter(isRetryableJobError);
    expect(retryable).toEqual([
      'provider_unreachable',
      'provider_timeout',
      'provider_unavailable',
      'invalid_response',
      'download_unreachable',
      'download_unavailable',
      'download_throttled',
    ]);
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
    expect(AnalyzeFilePayloadSchema.safeParse({ version: 3, model: 'm', mode: 'apply' }).success).toBe(false);
  });

  test('summary counts are non-negative integers and a pause names its reason', () => {
    const ok = {
      queued: 0,
      running: 1,
      waiting: 0,
      failed: 2,
      cancelled: 0,
      succeeded: 3,
      changes: 4,
      paused: [],
      pausedHosts: [],
    };
    expect(JobSummarySchema.safeParse(ok).success).toBe(true);
    expect(JobSummarySchema.safeParse({ ...ok, failed: -1 }).success).toBe(false);
    const pause = {
      providerId: 'environment',
      providerName: 'Environment',
      kind: 'ollama',
      reason: 'provider_unauthorized',
    };
    expect(JobSummarySchema.safeParse({ ...ok, paused: [pause] }).success).toBe(true);
    expect(
      JobSummarySchema.safeParse({ ...ok, paused: [{ ...pause, providerId: null, providerName: null }] }).success,
    ).toBe(true);
    expect(JobSummarySchema.safeParse({ ...ok, paused: [{ ...pause, reason: 'nope' }] }).success).toBe(false);
    expect(JobSummarySchema.safeParse({ ...ok, paused: { reason: 'provider_unauthorized' } }).success).toBe(false);
    expect(JobSummarySchema.safeParse({ ...ok, paused: null }).success).toBe(false);
    const { kind: _kind, ...withoutKind } = pause;
    expect(PausedProviderSchema.safeParse(withoutKind).success).toBe(false);
    expect(
      PausedProviderSchema.safeParse({ ...pause, kind: 'venice', reason: 'provider_insufficient_balance' }).success,
    ).toBe(true);
    expect(PausedProviderSchema.safeParse({ ...pause, kind: 'other' }).success).toBe(false);
    expect(ipcContract['jobs:summary'].response.safeParse({ ...ok, paused: [pause] }).success).toBe(true);
    const { paused: _paused, ...withoutPause } = ok;
    expect(JobSummarySchema.safeParse(withoutPause).success).toBe(false);
  });

  test('an enqueue result counts the skipped files per reason', () => {
    const skipped = { notFound: 1, notAnalysable: 0, alreadyQueued: 0, alreadyAnalysed: 0 };
    expect(EnqueueAnalysisResultSchema.safeParse({ enqueued: 1, skipped }).success).toBe(true);
    expect(
      EnqueueAnalysisResultSchema.safeParse({ enqueued: 1, skipped: [{ fileId: 'f', reason: 'not_found' }] }).success,
    ).toBe(false);
  });
});

const prompt = { name: 'Default', text: 'Tag this image.', maxTags: 15 };

describe('several providers', () => {
  test('a provider id is a UUID or environment', () => {
    expect(ProviderIdSchema.safeParse(uuid).success).toBe(true);
    expect(ProviderIdSchema.safeParse('environment').success).toBe(true);
    expect(ProviderIdSchema.safeParse('').success).toBe(false);
    expect(ProviderIdSchema.safeParse('env').success).toBe(false);
  });

  test('payload v4 carries the provider name; v1 to v3 still parse', () => {
    const v4 = { version: 4, model: 'm', mode: 'apply', providerName: 'RunPod' };
    expect(AnalyzeFilePayloadSchema.safeParse({ ...v4, prompt: null }).success).toBe(true);
    expect(AnalyzeFilePayloadSchema.safeParse({ ...v4, prompt }).success).toBe(true);
    expect(AnalyzeFilePayloadSchema.safeParse(v4).success).toBe(false);
    expect(AnalyzeFilePayloadSchema.safeParse({ ...v4, prompt: null, providerName: '' }).success).toBe(false);
    expect(AnalyzeFilePayloadSchema.safeParse({ version: 1 }).success).toBe(true);
    expect(AnalyzeFilePayloadSchema.safeParse({ version: 2, model: 'm', mode: 'propose' }).success).toBe(true);
    expect(AnalyzeFilePayloadSchema.safeParse({ version: 3, model: 'm', mode: 'apply', prompt }).success).toBe(true);
  });

  test('analysisJobFields reads the provider name of v4 and the model of v2 to v4', () => {
    expect(analysisJobFields({ version: 4, model: 'm', mode: 'apply', prompt: null, providerName: 'RunPod' })).toEqual({
      providerName: 'RunPod',
      model: 'm',
    });
    expect(analysisJobFields({ version: 3, model: 'm', mode: 'apply', prompt })).toEqual({
      providerName: null,
      model: 'm',
    });
    expect(analysisJobFields({ version: 2, model: 'm', mode: 'apply' })).toEqual({ providerName: null, model: 'm' });
    expect(analysisJobFields({ version: 1 })).toEqual({ providerName: null, model: null });
    expect(analysisJobFields('x')).toEqual({ providerName: null, model: null });
  });

  test('a job view carries provider id, provider name and model', () => {
    expect(JobViewSchema.safeParse({ ...view, providerId: uuid, providerName: 'RunPod', model: 'm' }).success).toBe(
      true,
    );
    expect(JobViewSchema.safeParse({ ...view, providerId: 'env' }).success).toBe(false);
    const { model: _model, ...withoutModel } = view;
    expect(JobViewSchema.safeParse(withoutModel).success).toBe(false);
  });

  test('jobs:reroute needs a model and accepts jobs without provider as source', () => {
    const request = ipcContract['jobs:reroute'].request;
    expect(request.safeParse({ fromProviderId: null, toProviderId: uuid, model: 'm' }).success).toBe(true);
    expect(request.safeParse({ fromProviderId: 'environment', toProviderId: uuid, model: 'm' }).success).toBe(true);
    expect(request.safeParse({ fromProviderId: null, toProviderId: uuid }).success).toBe(false);
    expect(request.safeParse({ fromProviderId: null, toProviderId: null, model: 'm' }).success).toBe(false);
    expect(ipcContract['jobs:reroute'].response.safeParse({ moved: 2 }).success).toBe(true);
    expect(ipcContract['jobs:reroute'].response.safeParse({ moved: -1 }).success).toBe(false);
  });

  test('jobs:resume names the provider; null is the jobs without one', () => {
    const request = ipcContract['jobs:resume'].request;
    expect(request.safeParse({}).success).toBe(false);
    expect(request.safeParse({ providerId: null }).success).toBe(true);
    expect(request.safeParse({ providerId: uuid }).success).toBe(true);
  });

  test('jobs:waitingByProvider counts waiting jobs per provider', () => {
    const response = ipcContract['jobs:waitingByProvider'].response;
    expect(response.safeParse([{ providerId: null, providerName: null, waiting: 3 }]).success).toBe(true);
    expect(response.safeParse([{ providerId: uuid, providerName: 'RunPod', waiting: -1 }]).success).toBe(false);
    expect(ipcContract['jobs:waitingByProvider'].request.safeParse({}).success).toBe(true);
  });

  test('jobs:list and the analysis channels take an optional provider id', () => {
    expect(ipcContract['jobs:list'].request.safeParse({ limit: 10, offset: 0, providerId: uuid }).success).toBe(true);
    expect(ipcContract['jobs:list'].request.safeParse({ limit: 10, offset: 0, providerId: 'x' }).success).toBe(false);
    const describeRequest = ipcContract['analysis:describe'].request;
    const base = { requestId: uuid, fileId: uuid, model: 'm' };
    expect(describeRequest.safeParse(base).success).toBe(true);
    expect(describeRequest.safeParse({ ...base, providerId: 'environment' }).success).toBe(true);
    expect(describeRequest.safeParse({ ...base, providerId: 'x' }).success).toBe(false);
    const target = { kind: 'files', fileIds: [uuid] };
    expect(ipcContract['analysis:preview'].request.safeParse({ target, model: 'm', providerId: uuid }).success).toBe(
      true,
    );
    expect(
      ipcContract['analysis:enqueue'].request.safeParse({
        target,
        model: 'm',
        mode: 'apply',
        force: false,
        providerId: uuid,
      }).success,
    ).toBe(true);
  });
});

describe('chosen ids', () => {
  const other = '8a1c2e3f-5b6d-4e7f-9a0b-1c2d3e4f5a6b';

  test('files:list and jobs:list take distinct chosen ids only', () => {
    for (const channel of ['files:list', 'jobs:list'] as const) {
      const request = ipcContract[channel].request;
      expect(request.safeParse({ limit: 2, offset: 0, scope: { kind: 'all' }, ids: [uuid, other] }).success).toBe(true);
      expect(request.safeParse({ limit: 2, offset: 0, scope: { kind: 'all' }, ids: [uuid, uuid] }).success).toBe(false);
      expect(request.safeParse({ limit: 2, offset: 0, scope: { kind: 'all' }, ids: [] }).success).toBe(false);
    }
  });
});
