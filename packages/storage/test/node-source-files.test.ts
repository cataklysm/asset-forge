import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SourceNotReadableError } from '@assetforge/core';
import { NodeSourceFiles } from '../src/index.js';

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'af-source-'));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('NodeSourceFiles', () => {
  it('opens a file and returns its base name and a readable stream', async () => {
    const file = path.join(tmp, 'pic.png');
    await fs.writeFile(file, 'data');
    const { name, stream } = await new NodeSourceFiles().open(file);
    expect(name).toBe('pic.png');
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('data');
  });

  it('answers the size of the file', async () => {
    const file = path.join(tmp, 'pic.png');
    await fs.writeFile(file, 'twelve bytes');
    const opened = await new NodeSourceFiles().open(file);
    expect(opened.sizeBytes).toBe(12);
    opened.stream.destroy();
  });

  it('answers size 0 for an empty file', async () => {
    const file = path.join(tmp, 'empty.png');
    await fs.writeFile(file, '');
    const opened = await new NodeSourceFiles().open(file);
    expect(opened.sizeBytes).toBe(0);
    opened.stream.destroy();
  });

  it('rejects a directory', async () => {
    await expect(new NodeSourceFiles().open(tmp)).rejects.toBeInstanceOf(SourceNotReadableError);
  });

  it('rejects a missing path with a message that carries no path', async () => {
    const err = await new NodeSourceFiles().open(path.join(tmp, 'nope')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceNotReadableError);
    expect((err as Error).message).toBe('This file cannot be read');
  });
});
