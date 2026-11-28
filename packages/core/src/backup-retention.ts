import { BACKUP_KEEP_DAYS, BACKUP_KEEP_NEWEST } from '@assetforge/contracts';
import { lineageShortId, parseBackupName, type ParsedBackupName } from './backup-names.js';

// Which regular backups of one lineage are pruned after a successful backup: the newest `BACKUP_KEEP_NEWEST` stay,
// plus the newest of each of the last `BACKUP_KEEP_DAYS` UTC days that has one. Names of other lineages and every
// name that does not parse (temporary files, the info file, pre-migration and replaced copies) are never selected.

/** One day in milliseconds. */
const DAY_MS = 86_400_000;

/**
 * The backups to delete from one backup directory.
 *
 * @param names the file names in the directory
 * @param lineageId the lineage of the database just backed up
 * @param justWritten the name of the backup just written; never selected
 * @param now the current time; its UTC date is the first of the kept days
 * @returns the names to delete, in no particular order
 */
export function pruneSelection(names: readonly string[], lineageId: string, justWritten: string, now: Date): string[] {
  const shortId = lineageShortId(lineageId);
  const considered = names
    .map((name) => parseBackupName(name))
    .filter((parsed): parsed is ParsedBackupName => parsed !== null && parsed.lineageShortId === shortId)
    .sort(newestFirst);
  const kept = keepSet(considered, now);
  kept.add(justWritten);
  return considered.map((parsed) => parsed.name).filter((name) => !kept.has(name));
}

/**
 * The names kept: the newest few and the newest of each recent day.
 *
 * @param ordered the considered backups, newest first
 * @param now the current time
 * @returns the kept names
 */
function keepSet(ordered: readonly ParsedBackupName[], now: Date): Set<string> {
  const kept = new Set(ordered.slice(0, BACKUP_KEEP_NEWEST).map((parsed) => parsed.name));
  for (const day of recentDays(now)) {
    const newestOfDay = ordered.find((parsed) => parsed.createdAt.slice(0, 10) === day);
    if (newestOfDay !== undefined) kept.add(newestOfDay.name);
  }
  return kept;
}

/**
 * The UTC dates of the kept days, today first.
 *
 * @param now the current time
 * @returns `BACKUP_KEEP_DAYS` dates as `yyyy-mm-dd`
 */
function recentDays(now: Date): string[] {
  return Array.from({ length: BACKUP_KEEP_DAYS }, (_, i) =>
    new Date(now.getTime() - i * DAY_MS).toISOString().slice(0, 10),
  );
}

/**
 * The total order of backups: stamp, then applied migrations, then name, each descending.
 *
 * @param first one backup
 * @param second another backup
 * @returns negative when `first` comes first
 */
function newestFirst(first: ParsedBackupName, second: ParsedBackupName): number {
  if (first.stamp !== second.stamp) return first.stamp < second.stamp ? 1 : -1;
  if (first.appliedMigrations !== second.appliedMigrations) return second.appliedMigrations - first.appliedMigrations;
  if (first.name === second.name) return 0;
  return first.name < second.name ? 1 : -1;
}
