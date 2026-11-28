import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { appendFile, mkdir, rename, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanLogLine,
  createLogFile,
  LINES_DROPPED_EVENT,
  LOG_FILE_MAX_BYTES,
  LOG_FILE_MAX_PENDING,
  LOG_FILE_NAME,
  LOG_LINE_MAX_CHARACTERS,
  type LogFileSystem,
} from '../src/main/log-file.js';
import { attachLogFile, flushMainLog, mainLog } from '../src/main/main-log.js';

// The bounded log file of the main process, on real temporary directories.

const STAMP = '2026-11-28T10:00:00.000Z';
const roots: string[] = [];
/** A flush deadline no test reaches, for tests that write many lines. */
const LONG_DEADLINE_MS = 60_000;

/**
 * A fresh temporary directory, removed after the test.
 *
 * @returns its path
 */
function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'assetforge-log-'));
  roots.push(root);
  return root;
}

/**
 * The lines of a log file without their trailing newline.
 *
 * @param path the file
 * @returns its lines
 */
function linesOf(path: string): string[] {
  return readFileSync(path, 'utf8').split('\n').slice(0, -1);
}

/** The Node file operations, so a test can replace one of them. */
const nodeFileSystem: LogFileSystem = {
  appendFile: (path, text) => appendFile(path, text, 'utf8'),
  stat: (path) => stat(path),
  rename: (from, to) => rename(from, to),
  unlink: (path) => unlink(path),
  mkdir: (path, options) => mkdir(path, options),
};

afterEach(() => {
  attachLogFile(null);
  vi.restoreAllMocks();
  // Retries: on Windows a scanner may still hold a file that was just written.
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('the log file', () => {
  it('appends every line with its UTC timestamp, in the order written', async () => {
    const directory = join(temporaryRoot(), 'logs');
    const file = createLogFile({ directory, now: () => new Date(STAMP) });
    for (let i = 0; i < 50; i++) file.write(`line ${i}`);
    await file.flush();
    const lines = linesOf(join(directory, LOG_FILE_NAME));
    expect(lines).toEqual(Array.from({ length: 50 }, (_, i) => `${STAMP} line ${i}`));
  });

  it('keeps the order of lines written while a write is under way', async () => {
    const directory = temporaryRoot();
    const file = createLogFile({ directory, now: () => new Date(STAMP) });
    file.write('first');
    await Promise.resolve();
    file.write('second');
    await file.flush();
    file.write('third');
    await file.flush();
    expect(linesOf(join(directory, LOG_FILE_NAME))).toEqual([`${STAMP} first`, `${STAMP} second`, `${STAMP} third`]);
  });

  it('rotates at the limit, keeping two older files and removing the oldest', async () => {
    const directory = temporaryRoot();
    const file = createLogFile({ directory, now: () => new Date(STAMP), flushDeadlineMs: LONG_DEADLINE_MS });
    // About 2 KB per entry, so the lines fill about five files; written in batches below the queue cap.
    const body = 'x'.repeat(LOG_LINE_MAX_CHARACTERS);
    const total = 2600;
    for (let i = 0; i < total; i++) {
      file.write(`${String(i).padStart(4, '0')} ${body}`);
      if (i % 500 === 499) await file.flush();
    }
    await file.flush();
    const names = ['assetforge.2.log', 'assetforge.1.log', LOG_FILE_NAME];
    expect(readdirSync(directory).sort()).toEqual([...names].sort());
    for (const name of names) expect(statSync(join(directory, name)).size).toBeLessThanOrEqual(LOG_FILE_MAX_BYTES);
    // Oldest file first: the kept lines are the newest ones, without a gap.
    const kept = names.flatMap((name) => linesOf(join(directory, name))).map((line) => Number(line.slice(25, 29)));
    expect(kept[0]).toBeGreaterThan(0);
    expect(kept).toEqual(Array.from({ length: kept.length }, (_, i) => kept[0]! + i));
    expect(kept.at(-1)).toBe(total - 1);
  });

  it('rotates when the next line would pass the limit, with the right lines in each file', async () => {
    const directory = temporaryRoot();
    const file = createLogFile({ directory, now: () => new Date(STAMP) });
    const filler = 'y'.repeat(LOG_FILE_MAX_BYTES - 10);
    writeFileSync(join(directory, LOG_FILE_NAME), filler);
    writeFileSync(join(directory, 'assetforge.1.log'), 'old one\n');
    writeFileSync(join(directory, 'assetforge.2.log'), 'oldest\n');
    file.write('new');
    await file.flush();
    expect(linesOf(join(directory, LOG_FILE_NAME))).toEqual([`${STAMP} new`]);
    expect(readFileSync(join(directory, 'assetforge.1.log'), 'utf8')).toBe(filler);
    expect(readFileSync(join(directory, 'assetforge.2.log'), 'utf8')).toBe('old one\n');
  });

  it('counts the size of an existing file at start', async () => {
    const directory = temporaryRoot();
    writeFileSync(join(directory, LOG_FILE_NAME), 'z'.repeat(LOG_FILE_MAX_BYTES - 100));
    const file = createLogFile({ directory, now: () => new Date(STAMP) });
    file.write('fits');
    await file.flush();
    expect(readdirSync(directory)).toEqual([LOG_FILE_NAME]);
    file.write('a'.repeat(200));
    await file.flush();
    expect(readdirSync(directory).sort()).toEqual(['assetforge.1.log', LOG_FILE_NAME]);
    expect(readFileSync(join(directory, 'assetforge.1.log'), 'utf8')).toMatch(/fits\n$/);
  });

  it('never throws on a failing write and writes later lines with the dropped count once it works again', async () => {
    const root = temporaryRoot();
    const directory = join(root, 'logs');
    // A file where the directory should be: every append and the directory creation fail.
    writeFileSync(directory, 'not a directory');
    const file = createLogFile({ directory, now: () => new Date(STAMP) });
    expect(() => file.write('lost 1')).not.toThrow();
    file.write('lost 2');
    await expect(file.flush()).resolves.toBeUndefined();
    rmSync(directory);
    file.write('back');
    await file.flush();
    expect(linesOf(join(directory, LOG_FILE_NAME))).toEqual([
      `${STAMP} ${LINES_DROPPED_EVENT}: count=2`,
      `${STAMP} back`,
    ]);
  });

  it('creates the directory again when it was removed', async () => {
    const directory = join(temporaryRoot(), 'logs');
    const file = createLogFile({ directory, now: () => new Date(STAMP) });
    file.write('one');
    await file.flush();
    rmSync(directory, { recursive: true });
    file.write('two');
    file.write('three');
    await file.flush();
    // The first append after the removal fails; the line is counted and the directory made again.
    expect(linesOf(join(directory, LOG_FILE_NAME))).toEqual([
      `${STAMP} ${LINES_DROPPED_EVENT}: count=1`,
      `${STAMP} three`,
    ]);
  });

  it('caps the queue, dropping and counting the oldest lines', async () => {
    const directory = temporaryRoot();
    const release: { open: () => void } = { open: () => {} };
    const gate = new Promise<void>((resolve) => (release.open = resolve));
    const fileSystem: LogFileSystem = {
      ...nodeFileSystem,
      appendFile: async (path, text) => {
        await gate;
        await appendFile(path, text, 'utf8');
      },
    };
    const file = createLogFile({
      directory,
      fileSystem,
      now: () => new Date(STAMP),
      flushDeadlineMs: LONG_DEADLINE_MS,
    });
    // The first line is taken by the stuck write; the queue holds the newest LOG_FILE_MAX_PENDING of the rest.
    const total = LOG_FILE_MAX_PENDING + 11;
    for (let i = 0; i < total; i++) file.write(`line ${i}`);
    release.open();
    await file.flush();
    const lines = linesOf(join(directory, LOG_FILE_NAME));
    expect(lines[0]).toBe(`${STAMP} line 0`);
    expect(lines[1]).toBe(`${STAMP} ${LINES_DROPPED_EVENT}: count=10`);
    expect(lines[2]).toBe(`${STAMP} line 11`);
    expect(lines.at(-1)).toBe(`${STAMP} line ${total - 1}`);
    expect(lines).toHaveLength(LOG_FILE_MAX_PENDING + 2);
  });

  it('cuts a line and strips its line breaks', async () => {
    expect(cleanLogLine('a\nb\r\nc\u2028d')).toBe('a b c d');
    expect(cleanLogLine('q'.repeat(LOG_LINE_MAX_CHARACTERS + 50))).toHaveLength(LOG_LINE_MAX_CHARACTERS);
    const directory = temporaryRoot();
    const file = createLogFile({ directory, now: () => new Date(STAMP) });
    file.write('one\ntwo');
    file.write('w'.repeat(5000));
    await file.flush();
    const lines = linesOf(join(directory, LOG_FILE_NAME));
    expect(lines).toEqual([`${STAMP} one two`, `${STAMP} ${'w'.repeat(LOG_LINE_MAX_CHARACTERS)}`]);
  });

  it('flushes at once when idle and gives up on a stuck write after its deadline', async () => {
    const directory = temporaryRoot();
    const idle = createLogFile({ directory });
    await expect(idle.flush()).resolves.toBeUndefined();
    const fileSystem: LogFileSystem = { ...nodeFileSystem, appendFile: () => new Promise<void>(() => {}) };
    const stuck = createLogFile({ directory, fileSystem, flushDeadlineMs: 50 });
    stuck.write('never written');
    const started = Date.now();
    await expect(stuck.flush()).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('the main log', () => {
  it('writes every line to the console and the attached log file', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const directory = temporaryRoot();
    mainLog('before');
    attachLogFile(createLogFile({ directory, now: () => new Date(STAMP) }));
    mainLog('after');
    await flushMainLog();
    expect(warn.mock.calls).toEqual([['before'], ['after']]);
    expect(linesOf(join(directory, LOG_FILE_NAME))).toEqual([`${STAMP} after`]);
  });

  it('flushes at once without a log file', async () => {
    await expect(flushMainLog()).resolves.toBeUndefined();
  });
});

const MAIN_SOURCE = fileURLToPath(new URL('../src/main/', import.meta.url));

/**
 * Every .ts file under the main-process source, as absolute paths.
 *
 * @param directory the directory to list, with a trailing slash
 * @returns the files
 */
function mainSources(directory = MAIN_SOURCE): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}${entry.name}`;
    if (entry.isDirectory()) return mainSources(`${path}/`);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

/**
 * The `console.` calls of a source file, comments left out.
 *
 * @param path the file
 * @returns how many there are
 */
function consoleCalls(path: string): number {
  const code = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  return code.match(/\bconsole\s*\./g)?.length ?? 0;
}

describe('the main-process sources', () => {
  it('write diagnostics only through the main log', () => {
    const sources = mainSources();
    const offenders = sources.filter((path) => basename(path) !== 'main-log.ts' && consoleCalls(path) > 0);
    expect(offenders).toEqual([]);
    expect(consoleCalls(join(MAIN_SOURCE, 'main-log.ts'))).toBe(1);
    expect(sources.length).toBeGreaterThan(50);
  });
});
