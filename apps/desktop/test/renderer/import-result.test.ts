import { describe, expect, it } from 'vitest';
import { importTitle, isZipPath } from '../../src/renderer/src/import-result.js';
import { importFailures } from '../../src/renderer/src/components/ResultStrip.js';
import { importResultOf } from './fake-api.js';
import { fileRecord } from './fixtures.js';

describe('isZipPath', () => {
  it.each([
    ['C:\\in\\pack.zip', true],
    ['C:\\in\\PACK.ZIP', true],
    ['/in/pack.Zip', true],
    ['C:\\in\\pack.zip.', true],
    ['C:\\in\\pack.zip . ', true],
    ['C:\\in\\pack.png', false],
    ['C:\\in\\pack.zipx', false],
    ['C:\\in\\zip', false],
    ['C:\\in.zip\\pack.png', false],
  ])('%s -> %s', (path, expected) => {
    expect(isZipPath(path)).toBe(expected);
  });
});

describe('importTitle', () => {
  const complete = fileRecord();
  const failedRow = fileRecord({ status: 'failed', sha256: null, error: 'The checksum did not match' });
  const results = [
    importResultOf('C:\\in\\a.png', { file: complete }),
    importResultOf('C:\\in\\b.png', { file: complete, duplicateOf: [complete.id] }),
    // A failed file row has a file and an error: it counts as failed only.
    importResultOf('C:\\in\\c.png', { file: failedRow, error: 'The checksum did not match' }),
    // An entry refusal.
    importResultOf('C:\\in\\pack.zip', { entryName: 'x.exe', error: 'This file type cannot be imported' }),
    importResultOf('C:\\in\\pack.zip', { entryName: 'd.png', file: complete }),
  ];

  it('counts complete files as imported and errors as failed', () => {
    expect(importTitle(results, { duplicates: false })).toBe('3 imported, 2 failed');
  });

  it('adds the duplicates when asked', () => {
    expect(importTitle(results, { duplicates: true })).toBe('3 imported, 2 failed, 1 duplicates');
  });

  it('a complete file with an error (placement failed) counts as imported and as failed', () => {
    const placed = [importResultOf('C:\\in\\a.png', { file: complete, error: 'The asset does not exist' })];
    expect(importTitle(placed, { duplicates: true })).toBe('1 imported, 1 failed, 0 duplicates');
  });

  it('an empty result', () => {
    expect(importTitle([], { duplicates: true })).toBe('0 imported, 0 failed, 0 duplicates');
  });
});

describe('importFailures', () => {
  it('names an entry failure with the archive and any other failure by its file name', () => {
    const failures = importFailures([
      importResultOf('C:\\in\\pack.zip', { entryName: 'a.exe', error: 'This file type cannot be imported' }),
      importResultOf('C:\\in\\broken.zip', { error: 'This file is not a readable ZIP archive' }),
      importResultOf('C:\\in\\c.exe', { error: 'This file type cannot be imported' }),
      importResultOf('C:\\in\\ok.png', { file: fileRecord() }),
    ]);
    expect(failures.map((f) => f.name)).toEqual(['a.exe (pack.zip)', 'broken.zip', 'c.exe']);
    expect(new Set(failures.map((f) => f.key)).size).toBe(3);
  });
});
