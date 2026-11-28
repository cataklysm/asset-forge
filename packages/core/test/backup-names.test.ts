import { describe, expect, it } from 'vitest';
import { backupFileName, lineageShortId, parseBackupName } from '../src/backup-names.js';

const LINEAGE = '0123456789abcdef0123456789abcdef';
const NAME = 'assetforge-0123456789ab-20261128T090503Z-m21.sqlite';

describe('backup names', () => {
  it('backupFileName drops the milliseconds and carries the short lineage and the migrations', () => {
    expect(backupFileName(LINEAGE, new Date('2026-11-28T09:05:03.999Z'), 21)).toBe(NAME);
  });

  it('lineageShortId takes the first twelve characters in lower case', () => {
    expect(lineageShortId('0123456789ABCDEF')).toBe('0123456789ab');
  });

  it('parseBackupName round-trips', () => {
    expect(parseBackupName(NAME)).toEqual({
      name: NAME,
      lineageShortId: '0123456789ab',
      stamp: '20261128T090503Z',
      createdAt: '2026-11-28T09:05:03.000Z',
      appliedMigrations: 21,
    });
  });

  it.each([
    ['upper-case hex', 'assetforge-0123456789AB-20261128T090503Z-m21.sqlite'],
    ['a temporary file', `${NAME}.tmp`],
    ['month 13', 'assetforge-0123456789ab-20261328T090503Z-m21.sqlite'],
    ['31 February', 'assetforge-0123456789ab-20260231T090503Z-m21.sqlite'],
    ['hour 24', 'assetforge-0123456789ab-20261128T240503Z-m21.sqlite'],
    ['a pre-migration copy', 'assetforge.sqlite.backup-3-20261128090503'],
  ])('parseBackupName answers null for %s', (_label, name) => {
    expect(parseBackupName(name)).toBeNull();
  });
});
