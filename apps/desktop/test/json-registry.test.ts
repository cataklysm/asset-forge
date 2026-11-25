import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonWorkspaceRegistry } from '../src/main/json-registry.js';

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const entry = (id: string, name: string, at: string) => ({
  id,
  name,
  rootPath: `/x/${name}`,
  lastOpenedAt: at,
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'af-registry-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('JsonWorkspaceRegistry', () => {
  it('lists an empty array for a missing file', async () => {
    expect(await new JsonWorkspaceRegistry(join(dir, 'settings.json')).list()).toEqual([]);
  });

  it('upserts by id, keeping the later values', async () => {
    const reg = new JsonWorkspaceRegistry(join(dir, 'settings.json'));
    await reg.upsert(entry(ID_A, 'one', '2026-01-01T00:00:00.000Z'));
    await reg.upsert(entry(ID_A, 'two', '2026-01-02T00:00:00.000Z'));
    await reg.upsert(entry(ID_B, 'other', '2026-01-03T00:00:00.000Z'));
    expect(await reg.list()).toHaveLength(2);
    expect(await reg.get(ID_A)).toEqual(entry(ID_A, 'two', '2026-01-02T00:00:00.000Z'));
    expect(await reg.get('33333333-3333-4333-8333-333333333333')).toBeNull();
  });

  it('persists across instances and creates the parent directory', async () => {
    const file = join(dir, 'nested', 'settings.json');
    await new JsonWorkspaceRegistry(file).upsert(entry(ID_A, 'one', '2026-01-01T00:00:00.000Z'));
    expect(await new JsonWorkspaceRegistry(file).list()).toEqual([entry(ID_A, 'one', '2026-01-01T00:00:00.000Z')]);
    expect(await readdir(join(dir, 'nested'))).toEqual(['settings.json']);
  });

  it('renames unparsable content to a corrupt file and reads empty', async () => {
    const file = join(dir, 'settings.json');
    await writeFile(file, 'not json');
    expect(await new JsonWorkspaceRegistry(file).list()).toEqual([]);
    const names = await readdir(dir);
    expect(names.filter((n) => n.startsWith('settings.json.corrupt-'))).toHaveLength(1);
    expect(names.some((n) => n.includes(':'))).toBe(false);
    expect(existsSync(file)).toBe(false);
  });

  it('treats valid JSON with the wrong shape as corrupt', async () => {
    const file = join(dir, 'settings.json');
    await writeFile(file, JSON.stringify({ workspaces: [{ id: 'nope' }] }));
    expect(await new JsonWorkspaceRegistry(file).list()).toEqual([]);
    expect((await readdir(dir)).some((n) => n.startsWith('settings.json.corrupt-'))).toBe(true);
  });

  it('removes an entry by id and ignores unknown ids', async () => {
    const file = join(dir, 'settings.json');
    const reg = new JsonWorkspaceRegistry(file);
    await reg.upsert(entry(ID_A, 'one', '2026-01-01T00:00:00.000Z'));
    await reg.upsert(entry(ID_B, 'other', '2026-01-03T00:00:00.000Z'));
    await reg.remove(ID_A);
    await reg.remove('33333333-3333-4333-8333-333333333333');
    expect(await new JsonWorkspaceRegistry(file).list()).toEqual([
      entry(ID_B, 'other', '2026-01-03T00:00:00.000Z'),
    ]);
  });

  it('remove on a missing file creates nothing', async () => {
    await new JsonWorkspaceRegistry(join(dir, 'settings.json')).remove(ID_A);
    expect(await readdir(dir)).toEqual([]);
  });
});
