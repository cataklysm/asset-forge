import { ANALYZE_FILE_JOB, FILE_DOWNLOAD_JOB, IMAGE_GENERATE_JOB } from '@assetforge/contracts';
import { describe, expect, it } from 'vitest';
import { jobViewOf, type Job } from '../src/index.js';

const T0 = '2026-01-01T00:00:00.000Z';

function jobOf(type: string, payload: unknown, lane: string | null): Job {
  return {
    id: 'j1',
    type,
    resourceClass: 'io',
    status: 'succeeded',
    fileId: 'f1',
    lane,
    payload,
    dedupeKey: null,
    attempt: 1,
    runAfter: null,
    errorCode: null,
    errorMessage: null,
    createdAt: T0,
    startedAt: T0,
    finishedAt: T0,
    updatedAt: T0,
  };
}

const generation = { providerName: 'Venice', model: 'edit-model' };

describe('jobViewOf', () => {
  it('shows a download with its address and host and without a provider', () => {
    const job = jobOf(
      FILE_DOWNLOAD_JOB,
      { v: 1, url: 'https://cdn.example.com/a.png', target: null, skipDuplicates: true },
      'cdn',
    );
    const view = jobViewOf(job, { fileName: 'a.png', generation, result: 'already_present' });
    expect(view).toMatchObject({
      providerId: null,
      providerName: null,
      model: null,
      url: 'https://cdn.example.com/a.png',
      host: 'cdn.example.com',
      fileName: 'a.png',
      result: 'already_present',
    });
  });

  it('shows a generation with the provider and model of its record', () => {
    const view = jobViewOf(jobOf(IMAGE_GENERATE_JOB, { v: 1, generationId: 'g' }, 'p1'), {
      fileName: null,
      generation,
      result: null,
    });
    expect(view).toMatchObject({ providerId: 'p1', providerName: 'Venice', model: 'edit-model', url: null });
    const gone = jobViewOf(jobOf(IMAGE_GENERATE_JOB, { v: 1, generationId: 'g' }, 'p1'), {
      fileName: null,
      generation: null,
      result: null,
    });
    expect(gone).toMatchObject({ providerName: null, model: null });
  });

  it('shows an analysis job with the provider name and model of its payload', () => {
    const payload = { version: 4, model: 'm', mode: 'apply', prompt: null, providerName: 'RunPod' };
    const view = jobViewOf(jobOf(ANALYZE_FILE_JOB, payload, 'p2'), { fileName: 'x.png', generation, result: null });
    expect(view).toEqual({
      id: 'j1',
      type: ANALYZE_FILE_JOB,
      status: 'succeeded',
      attempt: 1,
      fileId: 'f1',
      fileName: 'x.png',
      errorCode: null,
      errorMessage: null,
      createdAt: T0,
      startedAt: T0,
      finishedAt: T0,
      runAfter: null,
      providerId: 'p2',
      providerName: 'RunPod',
      model: 'm',
      url: null,
      host: null,
      result: null,
    });
  });
});
