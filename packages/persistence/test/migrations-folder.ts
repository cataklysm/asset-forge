import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MIGRATIONS_FOLDER } from '../src/index.js';

/** One entry of a Drizzle journal. */
export type JournalEntry = { idx: number; when: number; tag: string; version: string; breakpoints: boolean };

/**
 * A migrations folder with the shipped migrations before `count`, plus optional extra entries.
 *
 * @param folder the folder to create
 * @param count the number of shipped migrations to keep
 * @param extra extra migrations as tag and SQL, appended after the kept ones
 * @returns the folder
 */
export async function migrationsUpTo(
  folder: string,
  count: number,
  extra: { tag: string; sql: string }[] = [],
): Promise<string> {
  await mkdir(join(folder, 'meta'), { recursive: true });
  const journal = JSON.parse(await readFile(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as {
    entries: JournalEntry[];
  };
  journal.entries = journal.entries.filter((entry) => entry.idx < count);
  for (const entry of journal.entries) {
    await copyFile(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }
  let when = journal.entries.at(-1)!.when;
  for (const migration of extra) {
    when += 1000;
    journal.entries.push({ idx: journal.entries.length, when, tag: migration.tag, version: '6', breakpoints: true });
    await writeFile(join(folder, `${migration.tag}.sql`), migration.sql);
  }
  await writeFile(join(folder, 'meta', '_journal.json'), JSON.stringify(journal));
  return folder;
}
