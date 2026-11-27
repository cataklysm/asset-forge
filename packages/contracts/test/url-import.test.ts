import { describe, expect, test } from 'vitest';
import {
  FILE_DOWNLOAD_JOB,
  FileDownloadPayloadSchema,
  FileOriginSchema,
  IMPORT_URL_LINE_MAX,
  JOB_ERROR_MESSAGES,
  JobResultSchema,
  JobSummarySchema,
  JobViewSchema,
  MAX_FILE_ORIGINS,
  MAX_IMPORT_URLS,
  PausedHostSchema,
  UrlImportResultSchema,
  downloadJobFields,
  ipcContract,
  isRetryableJobError,
} from '../src/index';

const uuid = '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';

const DOWNLOAD_MESSAGES = {
  download_unreachable: 'The address could not be reached',
  download_unavailable: 'The server is temporarily unavailable',
  download_throttled: 'The server asked to slow down',
  download_blocked: 'The server refused access',
  download_not_found: 'The file was not found at this address',
  download_rejected: 'The server rejected the request',
  download_address_refused: 'This address is not allowed',
  download_too_large: 'The file is larger than the download limit',
  download_not_a_file: 'This address is a web page, not a file',
  download_type_refused: 'This file type cannot be imported',
  download_no_space: 'There is not enough free disk space',
  download_profile_missing: 'The site profile of this download no longer exists',
} as const;

const view = {
  id: 'j1',
  type: 'file.download',
  status: 'queued',
  attempt: 0,
  fileId: null,
  fileName: null,
  errorCode: null,
  errorMessage: null,
  createdAt: '2026-11-27T10:00:00.000Z',
  startedAt: null,
  finishedAt: null,
  runAfter: null,
  providerId: null,
  providerName: null,
  model: null,
  url: 'https://example.com/a.png',
  host: 'example.com',
  result: null,
};

describe('download job contracts', () => {
  test('the job type and the constants', () => {
    expect(FILE_DOWNLOAD_JOB).toBe('file.download');
    expect(MAX_IMPORT_URLS).toBe(5000);
    expect(MAX_FILE_ORIGINS).toBe(50);
    expect(IMPORT_URL_LINE_MAX).toBe(2000);
  });

  test.each(Object.entries(DOWNLOAD_MESSAGES))('%s has its fixed message', (code, message) => {
    expect(JOB_ERROR_MESSAGES[code as keyof typeof DOWNLOAD_MESSAGES]).toBe(message);
  });

  test('exactly three download codes are retryable', () => {
    const retryable = Object.keys(DOWNLOAD_MESSAGES).filter((c) => isRetryableJobError(c as keyof typeof DOWNLOAD_MESSAGES));
    expect(retryable).toEqual(['download_unreachable', 'download_unavailable', 'download_throttled']);
  });

  test('the download payload is v1 or v2', () => {
    const payload = { v: 1, url: 'https://example.com/a.png', target: null, skipDuplicates: true };
    expect(FileDownloadPayloadSchema.safeParse(payload).success).toBe(true);
    expect(FileDownloadPayloadSchema.safeParse({ ...payload, target: { assetId: uuid, role: 'reference' } }).success).toBe(true);
    expect(FileDownloadPayloadSchema.safeParse({ ...payload, v: 2 }).success).toBe(false);
    expect(FileDownloadPayloadSchema.safeParse({ ...payload, v: 3 }).success).toBe(false);
    const v2 = { ...payload, v: 2, siteProfileId: uuid, filter: { kinds: ['image', 'video'], minBytes: 1024 } };
    expect(FileDownloadPayloadSchema.safeParse(v2).success).toBe(true);
    expect(FileDownloadPayloadSchema.safeParse({ ...v2, siteProfileId: 'x' }).success).toBe(false);
    expect(FileDownloadPayloadSchema.safeParse({ ...v2, filter: { kinds: [], minBytes: 0 } }).success).toBe(false);
    const { filter: _f, ...withoutFilter } = v2;
    expect(FileDownloadPayloadSchema.safeParse(withoutFilter).success).toBe(false);
    expect(FileDownloadPayloadSchema.safeParse({ ...payload, url: '' }).success).toBe(false);
    expect(FileDownloadPayloadSchema.safeParse({ ...payload, url: 'x'.repeat(2001) }).success).toBe(false);
    const { skipDuplicates: _s, ...withoutSkip } = payload;
    expect(FileDownloadPayloadSchema.safeParse(withoutSkip).success).toBe(false);
  });

  test('downloadJobFields reads url and host; anything else yields nulls', () => {
    const url = 'https://Example.com:8443/a.png';
    expect(downloadJobFields({ v: 1, url, target: null, skipDuplicates: false })).toEqual({ url, host: 'example.com:8443' });
    expect(downloadJobFields({ v: 1, url: 'https://example.com:443/a.png', target: null, skipDuplicates: true })).toEqual({
      url: 'https://example.com:443/a.png',
      host: 'example.com',
    });
    expect(downloadJobFields({ v: 1, url: 'not a url', target: null, skipDuplicates: true })).toEqual({ url: null, host: null });
    expect(downloadJobFields({ version: 4, model: 'm', mode: 'apply', prompt: null, providerName: 'RunPod' })).toEqual({
      url: null,
      host: null,
    });
    expect(downloadJobFields(null)).toEqual({ url: null, host: null });
  });

  test('downloadJobFields reads a v2 payload', () => {
    const url = 'https://Cdn.Example.com:8443/a.png';
    const payload = { v: 2, url, target: null, skipDuplicates: true, siteProfileId: uuid, filter: { kinds: ['image'], minBytes: 0 } };
    expect(downloadJobFields(payload)).toEqual({ url, host: 'cdn.example.com:8443' });
  });

  test('a job view carries url, host and result', () => {
    expect(JobViewSchema.safeParse(view).success).toBe(true);
    expect(JobViewSchema.safeParse({ ...view, result: 'already_present' }).success).toBe(true);
    expect(JobViewSchema.safeParse({ ...view, result: 'other' }).success).toBe(false);
    const { result: _r, ...withoutResult } = view;
    expect(JobViewSchema.safeParse(withoutResult).success).toBe(false);
    expect(JobViewSchema.safeParse({ ...view, status: 'succeeded', result: 'filtered' }).success).toBe(true);
    expect(JobResultSchema.options).toEqual(['already_present', 'filtered']);
  });

  test('the summary lists paused hosts', () => {
    const ok = { queued: 0, running: 0, waiting: 0, failed: 0, cancelled: 0, succeeded: 0, changes: 0, paused: [], pausedHosts: [] };
    expect(JobSummarySchema.safeParse(ok).success).toBe(true);
    const host = { host: 'example.com', reason: 'download_blocked' };
    expect(JobSummarySchema.safeParse({ ...ok, pausedHosts: [host] }).success).toBe(true);
    expect(PausedHostSchema.safeParse({ ...host, reason: 'nope' }).success).toBe(false);
    const { pausedHosts: _p, ...withoutHosts } = ok;
    expect(JobSummarySchema.safeParse(withoutHosts).success).toBe(false);
  });
});

describe('URL import channels', () => {
  test('files:importUrls takes 1 to 5000 lines of at most 10000 characters', () => {
    const request = ipcContract['files:importUrls'].request;
    expect(request.safeParse({ urls: ['https://example.com/a.png'] }).success).toBe(true);
    expect(request.safeParse({ urls: ['x'.repeat(3000)], skipDuplicates: false }).success).toBe(true);
    expect(request.safeParse({ urls: ['x'.repeat(10000)] }).success).toBe(true);
    expect(request.safeParse({ urls: ['a', 'x'.repeat(10001)] }).success).toBe(false);
    expect(request.safeParse({ urls: ['a'], target: { assetId: uuid, role: 'reference' } }).success).toBe(true);
    expect(request.safeParse({ urls: [] }).success).toBe(false);
    expect(request.safeParse({ urls: Array.from({ length: 5000 }, () => 'a') }).success).toBe(true);
    expect(request.safeParse({ urls: Array.from({ length: 5001 }, () => 'a') }).success).toBe(false);
  });

  test('the import result counts and lists invalid lines', () => {
    const ok = { queued: 1, alreadyImported: 0, alreadyQueued: 2, invalid: [{ line: 3, text: 'nope' }] };
    expect(UrlImportResultSchema.safeParse(ok).success).toBe(true);
    expect(ipcContract['files:importUrls'].response.safeParse(ok).success).toBe(true);
    expect(UrlImportResultSchema.safeParse({ ...ok, invalid: [{ line: 0, text: 'x' }] }).success).toBe(false);
    expect(UrlImportResultSchema.safeParse({ ...ok, invalid: [{ line: 1, text: 'x'.repeat(201) }] }).success).toBe(false);
    expect(UrlImportResultSchema.safeParse({ ...ok, queued: -1 }).success).toBe(false);
  });

  test('files:origins, files:openOrigin and jobs:resumeHost', () => {
    const origin = { id: uuid, url: 'https://example.com/a.png', createdAt: '2026-11-27T10:00:00.000Z' };
    expect(FileOriginSchema.safeParse(origin).success).toBe(true);
    expect(ipcContract['files:origins'].request.safeParse({ fileId: uuid }).success).toBe(true);
    expect(ipcContract['files:origins'].request.safeParse({ fileId: 'x' }).success).toBe(false);
    expect(ipcContract['files:origins'].response.safeParse([origin]).success).toBe(true);
    expect(ipcContract['files:openOrigin'].request.safeParse({ fileId: uuid, originId: uuid }).success).toBe(true);
    expect(ipcContract['files:openOrigin'].request.safeParse({ fileId: uuid }).success).toBe(false);
    expect(ipcContract['jobs:resumeHost'].request.safeParse({ host: 'example.com' }).success).toBe(true);
    expect(ipcContract['jobs:resumeHost'].request.safeParse({ host: '' }).success).toBe(false);
    expect(ipcContract['jobs:resumeHost'].request.safeParse({ host: 'x'.repeat(301) }).success).toBe(false);
  });
});
