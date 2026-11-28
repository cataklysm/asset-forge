import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createImportDirectoryMemory, isSameDirectory } from '../src/main/import-directory.js';

let dir: string;
let source: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'af-import-dir-'));
  source = join(dir, 'source');
  mkdirSync(source);
  file = join(dir, 'memory', 'import-directory.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const writeRaw = (text: string) => {
  mkdirSync(join(dir, 'memory'), { recursive: true });
  writeFileSync(file, text);
};

describe('import directory memory', () => {
  it('remembers nothing at first', async () => {
    expect(await createImportDirectoryMemory(file).current()).toBeUndefined();
  });

  it('remembers the directory of the first path and survives a new instance', async () => {
    createImportDirectoryMemory(file).remember([join(source, 'a.png'), join(dir, 'b.png')]);
    expect(await createImportDirectoryMemory(file).current()).toBe(source);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ v: 1, directory: source });
  });

  it('ignores a removed directory and a path that is a file', async () => {
    const memory = createImportDirectoryMemory(file);
    memory.remember([join(source, 'a.png')]);
    rmSync(source, { recursive: true });
    expect(await memory.current()).toBeUndefined();
    writeFileSync(source, 'x');
    expect(await memory.current()).toBeUndefined();
  });

  it.each([
    ['malformed JSON', '{nope'],
    ['a wrong version', JSON.stringify({ v: 2, directory: '/x' })],
    ['an empty directory', JSON.stringify({ v: 1, directory: '' })],
    ['a relative directory', JSON.stringify({ v: 1, directory: 'source' })],
    ['a non-string directory', JSON.stringify({ v: 1, directory: 5 })],
  ])('treats %s as nothing remembered and repairs it on remember', async (_name, text) => {
    writeRaw(text);
    const memory = createImportDirectoryMemory(file);
    expect(await memory.current()).toBeUndefined();
    memory.remember([join(source, 'a.png')]);
    expect(await memory.current()).toBe(source);
  });

  it('writes nothing for an empty list', () => {
    createImportDirectoryMemory(file).remember([]);
    expect(existsSync(file)).toBe(false);
  });

  it('does not rewrite an unchanged directory', () => {
    const memory = createImportDirectoryMemory(file);
    memory.remember([join(source, 'a.png')]);
    writeRaw(readFileSync(file, 'utf8') + '\n');
    const before = readFileSync(file, 'utf8');
    memory.remember([join(source, 'b.png')]);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('does not rewrite the same directory spelled with another case or a trailing separator on Windows', () => {
    writeRaw(JSON.stringify({ v: 1, directory: 'C:\\Images\\Set' }));
    const before = readFileSync(file, 'utf8');
    const memory = createImportDirectoryMemory(file, { platform: 'win32' });
    memory.remember(['c:\\images\\SET\\a.png']);
    memory.remember(['C:/Images/Set/b.png']);
    expect(readFileSync(file, 'utf8')).toBe(before);
    memory.remember(['C:\\Images\\Other\\c.png']);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ v: 1, directory: 'C:\\Images\\Other' });
  });

  it('compares spellings by the rules of the platform', () => {
    expect(isSameDirectory('C:\\A\\b\\', 'c:\\a\\B', 'win32')).toBe(true);
    expect(isSameDirectory('C:\\A\\b', 'C:\\A\\c', 'win32')).toBe(false);
    expect(isSameDirectory('/a/b/', '/a/b', 'linux')).toBe(true);
    expect(isSameDirectory('/a/B', '/a/b', 'linux')).toBe(false);
  });

  it('keeps one check in flight per directory while it does not answer', async () => {
    createImportDirectoryMemory(file).remember([join(source, 'a.png')]);
    let calls = 0;
    let answer: (isDirectory: boolean) => void = () => {};
    const memory = createImportDirectoryMemory(file, {
      isDirectory: () => {
        calls += 1;
        return new Promise<boolean>((resolve) => {
          answer = resolve;
        });
      },
      timeoutMs: 10,
    });
    await expect(memory.current()).resolves.toBeUndefined();
    await expect(memory.current()).resolves.toBeUndefined();
    expect(calls).toBe(1);
    answer(true);
    await new Promise((resolve) => setImmediate(resolve));
    await expect(memory.current()).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });

  it('does not throw when the file cannot be written', async () => {
    // The target path is an existing directory, so the rename fails.
    mkdirSync(file, { recursive: true });
    const memory = createImportDirectoryMemory(file);
    expect(() => memory.remember([join(source, 'a.png')])).not.toThrow();
    await expect(memory.current()).resolves.toBeUndefined();
  });

  it('counts a directory check that does not answer in time as nothing remembered', async () => {
    createImportDirectoryMemory(file).remember([join(source, 'a.png')]);
    const memory = createImportDirectoryMemory(file, {
      isDirectory: () => new Promise<boolean>(() => {}),
      timeoutMs: 20,
    });
    await expect(memory.current()).resolves.toBeUndefined();
  });

  it('counts a directory check that rejects or throws as nothing remembered', async () => {
    createImportDirectoryMemory(file).remember([join(source, 'a.png')]);
    const rejecting = createImportDirectoryMemory(file, { isDirectory: () => Promise.reject(new Error('gone')) });
    await expect(rejecting.current()).resolves.toBeUndefined();
    const throwing = createImportDirectoryMemory(file, {
      isDirectory: () => {
        throw new Error('gone');
      },
    });
    await expect(throwing.current()).resolves.toBeUndefined();
  });
});
