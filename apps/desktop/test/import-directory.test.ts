import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createImportDirectoryMemory } from '../src/main/import-directory.js';

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
  it('remembers nothing at first', () => {
    expect(createImportDirectoryMemory(file).current()).toBeUndefined();
  });

  it('remembers the directory of the first path and survives a new instance', () => {
    createImportDirectoryMemory(file).remember([join(source, 'a.png'), join(dir, 'b.png')]);
    expect(createImportDirectoryMemory(file).current()).toBe(source);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ v: 1, directory: source });
  });

  it('ignores a removed directory and a path that is a file', () => {
    const memory = createImportDirectoryMemory(file);
    memory.remember([join(source, 'a.png')]);
    rmSync(source, { recursive: true });
    expect(memory.current()).toBeUndefined();
    writeFileSync(source, 'x');
    expect(memory.current()).toBeUndefined();
  });

  it.each([
    ['malformed JSON', '{nope'],
    ['a wrong version', JSON.stringify({ v: 2, directory: '/x' })],
    ['an empty directory', JSON.stringify({ v: 1, directory: '' })],
    ['a relative directory', JSON.stringify({ v: 1, directory: 'source' })],
    ['a non-string directory', JSON.stringify({ v: 1, directory: 5 })],
  ])('treats %s as nothing remembered and repairs it on remember', (_name, text) => {
    writeRaw(text);
    const memory = createImportDirectoryMemory(file);
    expect(memory.current()).toBeUndefined();
    memory.remember([join(source, 'a.png')]);
    expect(memory.current()).toBe(source);
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

  it('does not throw when the file cannot be written', () => {
    // The target path is an existing directory, so the rename fails.
    mkdirSync(file, { recursive: true });
    const memory = createImportDirectoryMemory(file);
    expect(() => memory.remember([join(source, 'a.png')])).not.toThrow();
    expect(() => memory.current()).not.toThrow();
    expect(memory.current()).toBeUndefined();
  });
});
