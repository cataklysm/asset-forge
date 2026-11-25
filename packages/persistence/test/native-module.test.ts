import Database from 'better-sqlite3';
import { expect, test } from 'vitest';

test('better-sqlite3 loads under the Electron ABI and supports FTS5', () => {
  expect(process.versions.electron).toBeDefined();
  const db = new Database(':memory:');
  db.exec("CREATE VIRTUAL TABLE t USING fts5(body); INSERT INTO t VALUES ('hello world');");
  expect(db.prepare("SELECT count(*) AS n FROM t WHERE t MATCH 'hello'").get()).toEqual({ n: 1 });
  db.close();
});
