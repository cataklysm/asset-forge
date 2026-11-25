import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { sql, type SQL } from 'drizzle-orm';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { AssetStatus, AssetType, FileKind, FileRole } from '@assetforge/contracts';
import { BUILT_IN_ASSET_TYPES, fileKind, searchWords, type AssetQuery, type WorkspaceDatabase } from '@assetforge/core';
import { MIGRATIONS_FOLDER, openWorkspaceDatabase } from '../src/index.js';
import { searchStatements } from '../src/search-index.js';

const ASSET_COUNT = 10_000;
const TAG_COUNT = 200;
/** Tags `0 .. ASSET_TAG_COUNT - 1` go on assets, the rest only on files. */
const ASSET_TAG_COUNT = 150;
const PROJECT_COUNT = 5;

const TS = '2026-01-01T00:00:00.000Z';
const uuid = (prefix: number, n: number) =>
  `${String(prefix).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const STORAGE = uuid(9, 0);

const ADJECTIVES = ['red', 'blue', 'rusty', 'golden', 'ancient', 'broken', 'mossy', 'tiny', 'heavy', 'silver'];
const NOUNS = ['sword', 'shield', 'lantern', 'barrel', 'crate', 'helmet', 'statue', 'bridge', 'tower', 'wagon'];
const DESCRIPTION_WORDS = ['worn', 'painted', 'carved', 'glowing', 'sworn', 'oak', 'iron', 'stone', 'cloth', 'leather'];
const ROLES: readonly FileRole[] = ['reference', 'concept', 'generated', 'working', 'model', 'texture', 'final', 'other'];
const EXTENSIONS = ['png', 'jpg', 'blend', 'glb', 'pdf', 'txt', 'zip'];
const STATUSES: readonly AssetStatus[] = ['draft', 'in_progress', 'in_review', 'completed', 'archived'];

/** Tables the search must reach only through an index; `m` is the alias of `asset_search_map`. */
/**
 * For each table the search may touch, the columns that key it on the row the outer loop holds:
 * the FTS rowid, the asset id, or the file id. A lookup must have an equality on one of them.
 */
const KEY_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  m: ['rowid'],
  asset_search_map: ['rowid'],
  asset: ['id'],
  tag: ['id'],
  asset_tag: ['asset_id'],
  file: ['asset_id', 'id'],
  file_tag: ['file_id'],
  project_asset: ['asset_id'],
  asset_workflow: ['asset_id'],
};
const INDEXED_TABLES = Object.keys(KEY_COLUMNS);
/** `EXISTS` marks a semi-join SQLite flattened from an `exists (...)` subquery; group 2 is the constraint. */
const INDEX_ACCESS =
  /^SEARCH (\S+)(?: EXISTS)? USING (?:COVERING INDEX \S+|INDEX \S+|INTEGER PRIMARY KEY|PRIMARY KEY) \((.*)\)$/;
/** The FTS table, driven by its MATCH constraint (`M` in the index string). */
const FTS_MATCH_SCAN = /^SCAN asset_search VIRTUAL TABLE INDEX \d+:M/;

interface SeededFile {
  role: FileRole;
  kind: FileKind;
  name: string;
  complete: boolean;
  tag: number;
}
interface SeededAsset {
  id: string;
  name: string;
  description: string;
  typeId: string;
  status: AssetStatus;
  tags: number[];
  files: SeededFile[];
  projectId: string | null;
}

/** Deterministic pseudo-random numbers (mulberry32). */
function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const tagLabel = (n: number) => `tag${String(n).padStart(3, '0')}`;

let dir: string;
let db: WorkspaceDatabase;
let sqlite: Database.Database;
let orm: BetterSQLite3Database;
let typeIds: string[];
const seeded: SeededAsset[] = [];

/** Seeds the workspace with prepared statements in one transaction. */
function seed(): void {
  const next = random(42);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
  const insertProject = sqlite.prepare(
    `insert into project (id, name, description, status, created_at, updated_at) values (?, ?, '', 'active', ?, ?)`,
  );
  const insertTag = sqlite.prepare(`insert into tag (id, name, display_name, created_at) values (?, ?, ?, ?)`);
  const insertAsset = sqlite.prepare(
    `insert into asset (id, name, type_id, description, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertAssetTag = sqlite.prepare(`insert into asset_tag (asset_id, tag_id, origin, created_at) values (?, ?, ?, ?)`);
  const insertFile = sqlite.prepare(
    `insert into file (id, storage_id, asset_id, role, original_name, relative_path, mime_type, size_bytes, sha256, kind, status, imported_at)
     values (?, ?, ?, ?, ?, ?, 'application/octet-stream', 1, ?, ?, ?, ?)`,
  );
  const insertFileTag = sqlite.prepare(`insert into file_tag (file_id, tag_id, origin, created_at) values (?, ?, ?, ?)`);
  const insertProjectAsset = sqlite.prepare(
    `insert into project_asset (project_id, asset_id, assigned_at, updated_at) values (?, ?, ?, ?)`,
  );

  sqlite.transaction(() => {
    const projectIds = Array.from({ length: PROJECT_COUNT }, (_, p) => uuid(1, p));
    projectIds.forEach((id, p) => insertProject.run(id, `Project ${p}`, TS, TS));
    for (let t = 0; t < TAG_COUNT; t++) insertTag.run(uuid(2, t), tagLabel(t), tagLabel(t), TS);
    let fileNumber = 0;
    for (let i = 0; i < ASSET_COUNT; i++) {
      const a: SeededAsset = {
        id: uuid(3, i),
        name: `${pick(ADJECTIVES)} ${pick(NOUNS)} ${i}`,
        description: `${pick(DESCRIPTION_WORDS)} ${pick(DESCRIPTION_WORDS)}`,
        typeId: pick(typeIds),
        status: pick(STATUSES),
        tags: [],
        files: [],
        projectId: i % 3 === 0 ? pick(projectIds) : null,
      };
      insertAsset.run(a.id, a.name, a.typeId, a.description, a.status, TS, TS);
      const tags = new Set<number>();
      while (tags.size < 3) tags.add(Math.floor(next() * ASSET_TAG_COUNT));
      a.tags = [...tags];
      for (const t of a.tags) insertAssetTag.run(a.id, uuid(2, t), next() < 0.5 ? 'manual' : 'ai', TS);
      const fileCount = next() < 0.5 ? 1 : 2;
      for (let f = 0; f < fileCount; f++) {
        const id = uuid(4, fileNumber++);
        const name = `${pick(NOUNS)}-${f}.${pick(EXTENSIONS)}`;
        const sf: SeededFile = {
          role: pick(ROLES),
          kind: fileKind(name),
          name,
          complete: next() < 0.9,
          tag: ASSET_TAG_COUNT + Math.floor(next() * (TAG_COUNT - ASSET_TAG_COUNT)),
        };
        a.files.push(sf);
        insertFile.run(
          id, STORAGE, a.id, sf.role, name, `assets/${a.id}/${id}.bin`, 'a'.repeat(64), sf.kind,
          sf.complete ? 'complete' : 'pending', TS,
        );
        insertFileTag.run(id, uuid(2, sf.tag), 'manual', TS);
      }
      if (a.projectId !== null) insertProjectAsset.run(a.projectId, a.id, TS, TS);
      seeded.push(a);
    }
  })();
}

/** Tokens like FTS5 `unicode61` produces for the ASCII seed data. */
const tokens = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** Brute-force count of the seeded assets the query matches. */
function bruteForceCount(q: AssetQuery): number {
  const words = searchWords(q.query ?? '');
  return seeded.filter((a) => {
    const complete = a.files.filter((f) => f.complete);
    const text = [
      a.name,
      a.description,
      ...a.tags.map(tagLabel),
      ...complete.map((f) => tagLabel(f.tag)),
      ...complete.map((f) => f.name),
    ].flatMap(tokens);
    if (!words.every((w) => text.some((t) => t.startsWith(w)))) return false;
    if (q.typeId !== undefined && a.typeId !== q.typeId) return false;
    if (q.status !== undefined && a.status !== q.status) return false;
    if (q.projectId !== undefined && a.projectId !== q.projectId) return false;
    if (q.fileRole !== undefined && !complete.some((f) => f.role === q.fileRole)) return false;
    if (q.fileKind !== undefined && !complete.some((f) => f.kind === q.fileKind)) return false;
    for (const name of q.tagNames ?? []) {
      if (!a.tags.map(tagLabel).includes(name) && !complete.some((f) => tagLabel(f.tag) === name)) return false;
    }
    return true;
  }).length;
}

/** The `detail` lines of `EXPLAIN QUERY PLAN` for a statement. */
const plan = (statement: SQL): string[] =>
  orm.all<{ detail: string }>(sql`explain query plan ${statement}`).map((r) => r.detail);

/**
 * Plan lines that break the rule: every SCAN is the FTS virtual table, and every listed table is
 * reached through a SEARCH using a key or an index.
 */
function violations(lines: readonly string[]): string[] {
  return lines.filter((line) => {
    if (line.startsWith('SCAN ')) return !FTS_MATCH_SCAN.test(line);
    const [, table] = /^SEARCH (\S+)/.exec(line) ?? [];
    if (table === undefined || !INDEXED_TABLES.includes(table)) return false;
    const access = INDEX_ACCESS.exec(line);
    if (access === null) return true;
    // The lookup must be keyed on the row the outer loop already holds, not on a selective-looking filter.
    const constraint = access[2]!.split(' AND ');
    return !KEY_COLUMNS[table]!.some((column) => constraint.includes(`${column}=?`));
  });
}

const firstAccess = (lines: readonly string[]) => lines.find((l) => /^(SCAN|SEARCH) /.test(l));

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'af-search-scale-'));
  const path = join(dir, 'ws.db');
  db = await openWorkspaceDatabase(path, MIGRATIONS_FOLDER);
  await db.meta.init({ id: uuid(0, 1), formatVersion: 1, name: 'ws', createdAt: TS });
  const types: AssetType[] = BUILT_IN_ASSET_TYPES.map((t, i) => ({
    id: uuid(0, 100 + i),
    key: t.key,
    name: t.name,
    sortOrder: i,
    builtIn: true,
    defaultWorkflowTemplateId: null,
  }));
  typeIds = types.map((t) => t.id);
  await db.assetTypes.insertMissing(types);
  await db.storages.ensurePrimary({ id: STORAGE, createdAt: TS });
  sqlite = new Database(path);
  orm = drizzle(sqlite);

  const seedStart = performance.now();
  seed();
  console.info(`seed of ${ASSET_COUNT} assets: ${Math.round(performance.now() - seedStart)} ms`);

  sqlite.prepare('update workspace set derived_data_version = null').run();
  const rebuildStart = performance.now();
  await db.ensureDerivedData();
  console.info(`ensureDerivedData rebuild over ${ASSET_COUNT} assets: ${Math.round(performance.now() - rebuildStart)} ms`);
  // No ANALYZE: production never collects statistics, so the plans are asserted without them.
}, 120_000);

afterAll(async () => {
  sqlite?.close();
  await db?.close();
  await rm(dir, { recursive: true, force: true });
});

describe('search scale', () => {
  test('the plan checker rejects a table scan and lookups not keyed on the owner', () => {
    expect(violations(plan(sql`select id from asset where lower(name) = 'x'`))).toEqual(['SCAN asset']);
    expect(violations(plan(sql`select count(*) from file where original_name = 'x'`))).not.toEqual([]);
    const notKeyed = [
      sql`select 1 from file where status = 'complete'`,
      sql`select 1 from file_tag where tag_id = 'x'`,
      sql`select 1 from asset_tag where tag_id = 'x'`,
      sql`select 1 from project_asset where project_id = 'x'`,
    ];
    for (const statement of notKeyed) {
      const lines = plan(statement);
      expect(lines.some((l) => l.startsWith('SEARCH '))).toBe(true);
      expect(violations(lines)).toEqual(lines.filter((l) => l.startsWith('SEARCH ')));
    }
    expect(violations(['SCAN asset_search VIRTUAL TABLE INDEX 0:'])).toEqual(['SCAN asset_search VIRTUAL TABLE INDEX 0:']);
  });

  test('search over 10 000 assets is driven by the match and uses indexes only', async () => {
    const tagged = seeded.find((a) => a.name.startsWith('red sword') && a.files.some((f) => f.complete))!;
    const filtered = seeded.find((a) => a.name.includes('sword') && a.projectId !== null && a.files.some((f) => f.complete))!;
    const filteredFile = filtered.files.find((f) => f.complete)!;
    const cases: { label: string; q: AssetQuery }[] = [
      { label: "'swo'", q: { limit: 50, offset: 0, query: 'swo' } },
      {
        label: "'red sword' + asset tag + file-only tag",
        q: {
          limit: 50,
          offset: 0,
          query: 'red sword',
          tagNames: [tagLabel(tagged.tags[0]!), tagLabel(tagged.files.find((f) => f.complete)!.tag)],
        },
      },
      {
        label: "'sword' + project + type + status + file role + file kind",
        q: {
          limit: 50,
          offset: 0,
          query: 'sword',
          projectId: filtered.projectId!,
          typeId: filtered.typeId,
          status: filtered.status,
          fileRole: filteredFile.role,
          fileKind: filteredFile.kind,
        },
      },
    ];

    for (const { label, q } of cases) {
      const statements = searchStatements(orm, { ...q, words: searchWords(q.query!) })!;
      expect(statements).not.toBeNull();
      for (const [name, statement] of Object.entries(statements)) {
        const lines = plan(statement);
        console.info(`plan of ${name} for ${label}:\n  ${lines.join('\n  ')}`);
        expect(firstAccess(lines)).toMatch(FTS_MATCH_SCAN);
        expect(violations(lines)).toEqual([]);
      }

      const pageStart = performance.now();
      orm.all(statements.page);
      const pageMs = performance.now() - pageStart;
      const countStart = performance.now();
      orm.get(statements.count);
      const countMs = performance.now() - countStart;

      const listStart = performance.now();
      const result = await db.assets.list(q);
      const listMs = performance.now() - listStart;
      console.info(
        `search ${label} over ${ASSET_COUNT} assets: ${Math.round(listMs)} ms ` +
          `(page statement ${pageMs.toFixed(1)} ms, count statement ${countMs.toFixed(1)} ms, total ${result.total})`,
      );
      expect(result.items.length).toBeGreaterThan(0);
      expect(result.total).toBe(bruteForceCount(q));
    }
  });
});
