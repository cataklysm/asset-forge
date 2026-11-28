import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JsonWorkspaceRegistry } from '../src/main/json-registry.js';

const renameFailure = vi.hoisted(() => ({ enabled: false }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    rename: async (from: string, to: string) => {
      if (renameFailure.enabled) throw new Error('rename refused');
      return original.rename(from, to);
    },
  };
});

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
    expect(await new JsonWorkspaceRegistry(file).list()).toEqual([entry(ID_B, 'other', '2026-01-03T00:00:00.000Z')]);
  });

  it('remove on a missing file creates nothing', async () => {
    await new JsonWorkspaceRegistry(join(dir, 'settings.json')).remove(ID_A);
    expect(await readdir(dir)).toEqual([]);
  });

  it('keeps every entry of concurrent upserts', async () => {
    const registry = new JsonWorkspaceRegistry(join(dir, 'settings.json'));
    const ids = Array.from({ length: 8 }, (_, i) => `${String(i).repeat(8)}-1111-4111-8111-111111111111`);
    await Promise.all(ids.map((id, i) => registry.upsert(entry(id, `w${i}`, '2026-01-01T00:00:00.000Z'))));
    expect((await registry.list()).map((workspace) => workspace.id).sort()).toEqual([...ids].sort());
  });

  it('sets an unreadable file aside once for concurrent reads', async () => {
    const file = join(dir, 'settings.json');
    await writeFile(file, 'not json');
    const registry = new JsonWorkspaceRegistry(file);
    expect(await Promise.all([registry.list(), registry.list(), registry.get(ID_A)])).toEqual([[], [], null]);
    expect((await readdir(dir)).filter((name) => name.startsWith('settings.json.corrupt-'))).toHaveLength(1);
  });

  it('keeps unknown top-level keys when it writes', async () => {
    const file = join(dir, 'settings.json');
    await writeFile(file, JSON.stringify({ theme: 'dark', workspaces: [] }));
    await new JsonWorkspaceRegistry(file).upsert(entry(ID_A, 'one', '2026-01-01T00:00:00.000Z'));
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      theme: 'dark',
      workspaces: [entry(ID_A, 'one', '2026-01-01T00:00:00.000Z')],
    });
  });

  it('removes the temporary file when the rename fails and keeps serving afterwards', async () => {
    const file = join(dir, 'settings.json');
    const registry = new JsonWorkspaceRegistry(file);
    renameFailure.enabled = true;
    await expect(registry.upsert(entry(ID_A, 'one', '2026-01-01T00:00:00.000Z'))).rejects.toThrow('rename refused');
    renameFailure.enabled = false;
    expect(await readdir(dir)).toEqual([]);
    await registry.upsert(entry(ID_B, 'other', '2026-01-03T00:00:00.000Z'));
    expect(await registry.list()).toEqual([entry(ID_B, 'other', '2026-01-03T00:00:00.000Z')]);
  });
});
