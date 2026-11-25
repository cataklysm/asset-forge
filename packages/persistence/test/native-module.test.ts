import Database from 'better-sqlite3';
import { expect, test } from 'vitest';

test('better-sqlite3 loads under the Electron ABI and supports FTS5', () => {
  expect(process.versions.electron).toBeDefined();
  const db = new Database(':memory:');
  db.exec("CREATE VIRTUAL TABLE t USING fts5(body); INSERT INTO t VALUES ('hello world');");
  expect(db.prepare("SELECT count(*) AS n FROM t WHERE t MATCH 'hello'").get()).toEqual({ n: 1 });
  db.close();
});

test('the bundled SQLite supports FTS5 with unicode61 remove_diacritics 2', () => {
  const db = new Database(':memory:');
  try {
    db.exec(
      `CREATE VIRTUAL TABLE asset_search USING fts5(name, description, tags, file_names,
         tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3');`,
    );
    db.prepare("INSERT INTO asset_search (name, description, tags, file_names) VALUES ('Café Sword', '', '', '')").run();
    const count = (q: string) =>
      db.prepare('SELECT count(*) AS n FROM asset_search WHERE asset_search MATCH ?').get(q);
    expect(count('"cafe"*')).toEqual({ n: 1 });
    expect(count('"swo"*')).toEqual({ n: 1 });
  } finally {
    db.close();
  }
});
