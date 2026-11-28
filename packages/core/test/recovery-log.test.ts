import { describe, expect, it } from 'vitest';
import {
  createRecoveryFailureLog,
  inboxPath,
  logRecoverySummary,
  RECOVERY_FAILURE_EVENT,
  RECOVERY_SUMMARY_EVENT,
  recoverFileMoves,
  recoverIncompleteImports,
  reportRecoveryFailure,
  stagingPath,
  sweepTrash,
  trashPath,
  WorkspaceManager,
  type RecoveryCounts,
} from '../src/index.js';
import { createFakeHost } from './fakes.js';

const MARKER = 'SECRET_PATH_MARKER';
const ROOT = `/ws/${MARKER}`;
const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const ID3 = '33333333-3333-4333-8333-333333333333';
const STORAGE_ID = '44444444-4444-4444-8444-444444444444';

const ZERO: RecoveryCounts = {
  importsFailed: 0,
  importsDiscarded: 0,
  stagingRemoved: 0,
  pathsSkipped: 0,
  movesCompleted: 0,
  movesDiscarded: 0,
  trashRemoved: 0,
  trashSkipped: 0,
  unrepaired: 0,
};

/**
 * A Node-like error with the marker in every text field.
 *
 * @param code the system code
 * @returns the error
 */
function pathError(code: string): Error {
  return Object.assign(new Error(`${code}: busy, unlink '/data/${MARKER}/a.png'`), {
    code,
    syscall: 'unlink',
    path: `/data/${MARKER}/a.png`,
    stack: `Error: at /data/${MARKER}/a.png`,
  });
}

/**
 * A workspace whose host log collects its lines.
 *
 * @returns the fakes, the manager, the workspace and the lines
 */
async function setup() {
  const fake = createFakeHost();
  const lines: string[] = [];
  fake.host.log = (line) => lines.push(line);
  const manager = new WorkspaceManager(fake.host);
  const summary = await manager.create({ name: 'Demo', rootPath: ROOT });
  const storage = fake.storages.get(ROOT)!;
  const db = fake.databases.get(summary.id)!;
  return { ...fake, manager, summary, storage, db, lines };
}

/**
 * A pending row named with the marker.
 *
 * @param id the file id
 * @returns the row
 */
const pending = (id: string) => ({
  id,
  storageId: STORAGE_ID,
  originalName: `${MARKER}.png`,
  relativePath: inboxPath(id, `${MARKER}.png`),
  mimeType: 'image/png',
  importedAt: '2026-01-01T00:00:00.000Z',
  kind: 'image' as const,
});

describe('the recovery lines', () => {
  it('writes no summary when nothing was done', () => {
    const lines: string[] = [];
    logRecoverySummary((line) => lines.push(line), ID1, ZERO);
    expect(lines).toEqual([]);
  });

  it('writes every count once one is not zero', () => {
    const lines: string[] = [];
    logRecoverySummary((line) => lines.push(line), ID1, { ...ZERO, movesCompleted: 2 });
    expect(lines).toEqual([
      `${RECOVERY_SUMMARY_EVENT}: workspace=${ID1} importsFailed=0 importsDiscarded=0 stagingRemoved=0 pathsSkipped=0 ` +
        'movesCompleted=2 movesDiscarded=0 trashRemoved=0 trashSkipped=0 unrepaired=0',
    ]);
  });

  it('counts the reported items and keeps going when the report throws', () => {
    const failures = createRecoveryFailureLog(() => {
      throw new Error('console gone');
    }, ID1);
    reportRecoveryFailure(failures.report, 'import', ID2, pathError('EBUSY'));
    reportRecoveryFailure(
      () => {
        throw new Error('report gone');
      },
      'import',
      ID2,
      null,
    );
    expect(failures.count()).toBe(1);
  });
});

describe('recovery on open', () => {
  it('writes nothing for an open without work', async () => {
    const { manager, lines } = await setup();
    await manager.close();
    await manager.open({ rootPath: ROOT });
    expect(lines).toEqual([]);
  });

  it('writes one summary with the counts of every step', async () => {
    const { manager, storage, db, summary, lines } = await setup();
    await db.files.insertPending(pending(ID1));
    storage.files.set(stagingPath(ID1), Buffer.from('partial'));
    storage.files.set(stagingPath(ID3), Buffer.from('orphan'));
    db.files.purged.add(ID2);
    storage.files.set(trashPath(ID2, `${MARKER}.png`), Buffer.from('left'));
    await manager.close();

    await manager.open({ rootPath: ROOT });

    expect(lines).toEqual([
      `${RECOVERY_SUMMARY_EVENT}: workspace=${summary.id} importsFailed=1 importsDiscarded=0 stagingRemoved=2 ` +
        'pathsSkipped=0 movesCompleted=0 movesDiscarded=0 trashRemoved=1 trashSkipped=0 unrepaired=0',
    ]);
  });

  it('writes one line per item left as it was, with its id and no path', async () => {
    const { manager, storage, db, summary, lines } = await setup();
    await db.files.insertPending(pending(ID1));
    storage.files.set(stagingPath(ID1), Buffer.from('partial'));
    await manager.close();
    storage.failNext('remove', pathError('EBUSY'));

    await manager.open({ rootPath: ROOT });

    expect(lines).toEqual([
      `${RECOVERY_FAILURE_EVENT}: workspace=${summary.id} item=import file=${ID1} error=Error code=EBUSY syscall=unlink`,
      `${RECOVERY_SUMMARY_EVENT}: workspace=${summary.id} importsFailed=0 importsDiscarded=0 stagingRemoved=1 ` +
        'pathsSkipped=1 movesCompleted=0 movesDiscarded=0 trashRemoved=0 trashSkipped=0 unrepaired=1',
    ]);
    for (const line of lines) expect(line).not.toContain(MARKER);
  });
});

describe('the reports of the recovery steps', () => {
  it('name an orphaned staging entry without its name', async () => {
    const { storage, db } = await setup();
    storage.files.set(stagingPath(ID3), Buffer.from('orphan'));
    storage.failNext('remove', pathError('EPERM'));
    const reports: unknown[][] = [];
    await recoverIncompleteImports({ storage, files: db.files, onFailure: (...report) => reports.push(report) });
    expect(reports.map(([item, fileId]) => [item, fileId])).toEqual([['staging entry', null]]);
  });

  it('name a pending row whose state could not be written, and a listing that failed', async () => {
    const { storage, db } = await setup();
    await db.files.insertPending(pending(ID1));
    const files = Object.create(db.files) as typeof db.files;
    files.markFailed = () => Promise.reject(pathError('SQLITE_BUSY'));
    const reports: unknown[][] = [];
    const onFailure = (...report: unknown[]) => reports.push(report);
    await recoverIncompleteImports({ storage, files, onFailure });
    storage.failNext('list', pathError('EIO'));
    await recoverIncompleteImports({ storage, files: db.files, onFailure });

    expect(reports.map(([item, fileId]) => [item, fileId])).toEqual([
      ['import', ID1],
      ['staging list', null],
    ]);
  });

  it('name a move row that could not be resolved', async () => {
    const { storage, db } = await setup();
    const fileMoves = Object.create(db.fileMoves) as typeof db.fileMoves;
    fileMoves.list = async () => [
      {
        fileId: ID1,
        kind: 'trash',
        targetRelativePath: trashPath(ID1, 'a.png'),
        targetAssetId: null,
        targetRole: null,
        createdAt: '2026-01-02T00:00:00.000Z',
      },
    ];
    const files = Object.create(db.files) as typeof db.files;
    files.get = () => Promise.reject(pathError('SQLITE_IOERR'));
    const reports: unknown[][] = [];
    await recoverFileMoves({ storage, files, fileMoves, onFailure: (...report) => reports.push(report) });
    expect(reports.map(([item, fileId]) => [item, fileId])).toEqual([['file move', ID1]]);
  });

  it('name a trash binary and a tombstone by their validated id', async () => {
    const { storage, db } = await setup();
    db.files.purged.add(ID2);
    db.files.purged.add(ID3);
    storage.files.set(trashPath(ID2, 'a.png'), Buffer.from('left'));
    storage.failNext('remove', pathError('EBUSY'));
    const files = Object.create(db.files) as typeof db.files;
    files.forgetPurge = () => Promise.reject(pathError('SQLITE_BUSY'));
    const reports: unknown[][] = [];
    await sweepTrash({ storage, files, onFailure: (...report) => reports.push(report) });
    expect(reports.map(([item, fileId]) => [item, fileId])).toEqual([
      ['trash binary', ID2],
      ['tombstone', ID3],
    ]);
  });
});
