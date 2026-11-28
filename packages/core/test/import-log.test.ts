import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  createAsset,
  importArchive,
  importFile,
  importStream,
  IMPORT_FAILED_EVENT,
  MAX_ARCHIVE_BYTES,
  MAX_ARCHIVE_ENTRIES,
  StorageFullError,
  WorkspaceManager,
  type ImportContext,
  type WorkspaceSession,
} from '../src/index.js';
import { createFakeHost } from './fakes.js';

const ROOT = '/ws/SECRET_PATH_MARKER';
const MARKER = 'SECRET_PATH_MARKER';

/**
 * An error that carries the marker in every text field, as a Node error carries the path.
 *
 * @param code the system code
 * @returns the error
 */
function pathError(code = 'ENOSPC'): Error {
  const error = new Error(`${code}: no space left on device, write '/data/${MARKER}/a.png'`) as Error & {
    code: string;
    path: string;
    syscall: string;
  };
  error.code = code;
  error.path = `/data/${MARKER}/a.png`;
  error.syscall = 'write';
  error.stack = `Error: at /data/${MARKER}/a.png\n    at write (/app/${MARKER}/x.js:1:1)`;
  return error;
}

/**
 * A workspace with a fake log that collects lines.
 *
 * @returns the fakes, the manager, the lines and an import context logging into them
 */
async function setup() {
  const fake = createFakeHost();
  const lines: string[] = [];
  fake.host.log = (line) => lines.push(line);
  const manager = new WorkspaceManager(fake.host);
  const summary = await manager.create({ name: 'Demo', rootPath: ROOT });
  const storage = fake.storages.get(ROOT)!;
  const db = fake.databases.get(summary.id)!;
  const context: ImportContext = {
    storage,
    storageId: '99999999-9999-4999-8999-999999999999',
    files: db.files,
    sources: fake.sources,
    probe: fake.probe,
    newId: () => crypto.randomUUID(),
    now: () => new Date(),
    log: (line) => lines.push(line),
  };
  return { ...fake, manager, storage, db, context, lines };
}

/**
 * Asserts that no line carries the marker.
 *
 * @param lines the collected lines
 */
function expectNoMarker(lines: string[]): void {
  for (const line of lines) expect(line).not.toContain(MARKER);
}

describe('import failure lines', () => {
  it('logs an unexpected storage failure with the operation, the file id and the system code only', async () => {
    const { context, sources, storage, lines } = await setup();
    sources.set(`/src/${MARKER}/ref.png`, Buffer.from('hello'));
    storage.failNext('move', pathError());
    const result = await importFile(context, `/src/${MARKER}/ref.png`);

    expect(result.file?.status).toBe('failed');
    expect(lines).toEqual([
      `${IMPORT_FAILED_EVENT}: operation=import file=${result.file!.id} error=Error code=ENOSPC syscall=write`,
    ]);
    expectNoMarker(lines);
  });

  it('writes nothing for a domain error, whose code already tells the user', async () => {
    const { context, sources, storage, lines } = await setup();
    sources.set('/src/ref.png', Buffer.from('hello'));
    storage.failNext('move', new StorageFullError('Not enough free space', { cause: pathError() }));
    await importFile(context, '/src/ref.png');
    sources.set('/src/missing.png', Buffer.from('x'));
    sources.unreadable.add('/src/missing.png');
    await importFile(context, '/src/missing.png');

    expect(lines).toEqual([]);
  });

  it('logs a source that fails to open unexpectedly, without a file id', async () => {
    const { context, lines } = await setup();
    const sources = { open: () => Promise.reject(pathError('EPERM')) };
    const result = await importFile({ ...context, sources }, `/src/${MARKER}/ref.png`);

    expect(result.file).toBeNull();
    expect(lines).toEqual([`${IMPORT_FAILED_EVENT}: operation=import error=Error code=EPERM syscall=write`]);
  });

  it('logs a pending row that cannot be written', async () => {
    const { context, sources, lines } = await setup();
    sources.set('/src/ref.png', Buffer.from('hello'));
    const files = Object.create(context.files) as ImportContext['files'];
    files.insertPending = () =>
      Promise.reject(Object.assign(new Error(`disk I/O at ${MARKER}`), { code: 'SQLITE_IOERR' }));
    await importFile({ ...context, files }, '/src/ref.png');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^Import failed unexpectedly: operation=import file=[0-9a-f-]{36} error=Error code=SQLITE_IOERR$/,
    );
  });

  it('labels a body with an origin as a download', async () => {
    const { context, storage, lines } = await setup();
    storage.failNext('move', pathError());
    const url = `https://${MARKER}.example/a.png`;
    const stream = Readable.from([Buffer.from('x')]);
    await importStream(
      context,
      { sourcePath: url, entryName: null, name: 'a.png', stream },
      { origin: { id: crypto.randomUUID(), url } },
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('operation=download');
    expectNoMarker(lines);
  });

  it('logs an archive that fails to open and an entry that fails to open by its position', async () => {
    const { context, archives, lines } = await setup();
    const budget = () => ({ entries: MAX_ARCHIVE_ENTRIES, bytes: MAX_ARCHIVE_BYTES });
    const failing = { open: () => Promise.reject(pathError('EIO')) };
    await importArchive({ ...context, archives: failing }, `/src/${MARKER}.zip`, budget(), async () => {});

    archives.set(`/src/${MARKER}/b.zip`, [
      { name: `${MARKER}/one.png`, content: 'one', failOpen: true },
      { name: 'two.png', content: 'two' },
    ]);
    const results = await importArchive({ ...context, archives }, `/src/${MARKER}/b.zip`, budget(), async () => {});

    expect(results.map((result) => result.file?.status ?? null)).toEqual([null, 'complete']);
    expect(lines).toEqual([
      `${IMPORT_FAILED_EVENT}: operation=archive error=Error code=EIO syscall=write`,
      `${IMPORT_FAILED_EVENT}: operation=archive entry entry=0 error=Error`,
    ]);
    expectNoMarker(lines);
  });

  it('logs a file that could not be placed in its asset', async () => {
    const { manager, sources, storage, db, lines } = await setup();
    const session: WorkspaceSession = await manager.read(async (s) => s);
    const typeId = (await db.assetTypes.list())[0]!.id;
    const asset = await createAsset(session, { name: 'Car', typeId });
    sources.set('/src/ref.png', Buffer.from('hello'));
    // The first move is the import's staging -> inbox move; the placement is the second.
    const move = storage.move.bind(storage);
    let calls = 0;
    vi.spyOn(storage, 'move').mockImplementation(async (from, to) => {
      if (++calls === 2) throw pathError('EBUSY');
      return move(from, to);
    });
    const results = await manager.importFiles(['/src/ref.png'], { assetId: asset.id, role: 'texture' });

    expect(results[0]!.error).not.toBeNull();
    expectNoMarker(lines);
    expect(lines).toEqual([
      `${IMPORT_FAILED_EVENT}: operation=placement file=${results[0]!.file!.id} error=InvalidOperationError code=invalid_operation cause=(Error code=EBUSY syscall=write)`,
    ]);
  });

  it('a thrown value with throwing getters never skips the cleanup that follows the line', async () => {
    const { context, sources, storage, db, lines } = await setup();
    sources.set('/src/ref.png', Buffer.from('hello'));
    const hostile = new Error('boom');
    Object.defineProperty(hostile, 'name', {
      get() {
        throw new Error('name getter');
      },
    });
    storage.failNext('move', hostile);

    const result = await importFile(context, '/src/ref.png');

    expect(result.file?.status).toBe('failed');
    expect(db.files.records.get(result.file!.id)?.status).toBe('failed');
    expect([...storage.files.keys()].filter((path) => path.includes('staging'))).toEqual([]);
    expect(lines).toEqual([]);
  });
});
