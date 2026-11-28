import { describe, expect, test } from 'vitest';
import {
  BACKUP_FAILURE_CODES,
  BACKUP_MESSAGES,
  BackupAttemptSchema,
  BackupEntrySchema,
  BackupListingSchema,
  ErrorCodeSchema,
  ipcContract,
} from '../src/index';

const uuid = '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';

const entry = {
  backupId: uuid,
  createdAt: '2026-11-28T09:05:03.000Z',
  sizeBytes: 4096,
  appliedMigrations: 21,
  origin: 'regular',
  sameLineage: true,
} as const;

describe('backup contracts', () => {
  test('BackupEntrySchema refuses a path-like backupId', () => {
    expect(BackupEntrySchema.safeParse(entry).success).toBe(true);
    expect(BackupEntrySchema.safeParse({ ...entry, backupId: '../assetforge.sqlite' }).success).toBe(false);
    expect(BackupEntrySchema.safeParse({ ...entry, backupId: 'C:\\backups\\a.sqlite' }).success).toBe(false);
  });

  test('workspace:backups accepts id or rootPath, not neither', () => {
    const request = ipcContract['workspace:backups'].request;
    expect(request.safeParse({ id: uuid }).success).toBe(true);
    expect(request.safeParse({ rootPath: 'D:\\Assets', pickFolder: true }).success).toBe(true);
    expect(request.safeParse({}).success).toBe(false);
    expect(request.safeParse({ pickFolder: true }).success).toBe(false);
    expect(request.safeParse({ id: uuid, rootPath: 'D:\\Assets' }).success).toBe(false);
    expect(request.safeParse({ rootPath: '' }).success).toBe(false);
  });

  test('every backup failure code is in ErrorCodeSchema', () => {
    for (const code of BACKUP_FAILURE_CODES) expect(ErrorCodeSchema.safeParse(code).success, code).toBe(true);
    expect(ErrorCodeSchema.safeParse('workspace_database_missing').success).toBe(true);
    expect(Object.keys(BACKUP_MESSAGES).sort()).toEqual([...BACKUP_FAILURE_CODES].sort());
  });

  test('backup requests refuse a path field', () => {
    expect(ipcContract['backup:delete'].request.safeParse({ backupId: uuid }).success).toBe(true);
    expect(ipcContract['backup:delete'].request.safeParse({ backupId: uuid, path: 'D:\\x' }).success).toBe(false);
    expect(ipcContract['backup:changeLocation'].request.safeParse({ path: 'D:\\x' }).success).toBe(false);
    expect(ipcContract['workspace:restore'].request.safeParse({ rootPath: 'D:\\Assets', backupId: uuid }).success).toBe(
      true,
    );
    expect(
      ipcContract['workspace:restore'].request.safeParse({ rootPath: 'D:\\Assets', backupId: uuid, path: 'x' }).success,
    ).toBe(false);
  });

  test('a listing and an attempt parse in their shapes', () => {
    expect(BackupListingSchema.safeParse({ backups: [entry], unreachable: false }).success).toBe(true);
    expect(BackupListingSchema.safeParse([entry]).success).toBe(false);
    expect(
      BackupAttemptSchema.safeParse({
        at: '2026-11-28T09:05:03.000Z',
        ok: false,
        code: 'backup_no_space',
        message: BACKUP_MESSAGES.backup_no_space,
      }).success,
    ).toBe(true);
    expect(
      BackupAttemptSchema.safeParse({
        at: '2026-11-28T09:05:03.000Z',
        ok: false,
        code: 'internal_error',
        message: null,
      }).success,
    ).toBe(false);
  });

  test('workspace:open takes startEmpty', () => {
    expect(ipcContract['workspace:open'].request.safeParse({ rootPath: 'D:\\Assets', startEmpty: true }).success).toBe(
      true,
    );
  });
});
