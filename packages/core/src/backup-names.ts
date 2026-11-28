// The file names of regular backups: `assetforge-<lineage short id>-<yyyymmddThhmmssZ>-m<applied migrations>.sqlite`.
// Everything a listing needs is in the name, so a backup is opened only after it was copied to the local disk.

/** How many leading characters of the lineage id a backup name carries. */
export const LINEAGE_SHORT_LENGTH = 12;
/** A finished regular backup: lineage short id, UTC stamp and applied migrations. */
export const BACKUP_NAME_PATTERN = /^assetforge-([0-9a-f]{12})-(\d{8}T\d{6}Z)-m(\d{1,4})\.sqlite$/;
/** A regular backup still being written to its place. */
export const BACKUP_TEMPORARY_PATTERN = /^assetforge-[0-9a-f]{12}-\d{8}T\d{6}Z-m\d{1,4}\.sqlite\.tmp$/;

/** A regular backup name taken apart. */
export interface ParsedBackupName {
  /** The whole file name. */
  name: string;
  /** The first `LINEAGE_SHORT_LENGTH` characters of the lineage id. */
  lineageShortId: string;
  /** The stamp as written in the name, `yyyymmddThhmmssZ`; string order is time order. */
  stamp: string;
  /** The stamp as an ISO timestamp (UTC, whole seconds). */
  createdAt: string;
  /** The number of migrations applied to the copied database. */
  appliedMigrations: number;
}

/**
 * The short lineage id a backup name carries.
 *
 * @param lineageId the lineage id of a database (32 hex characters)
 * @returns its first `LINEAGE_SHORT_LENGTH` characters, lower case
 */
export function lineageShortId(lineageId: string): string {
  return lineageId.slice(0, LINEAGE_SHORT_LENGTH).toLowerCase();
}

/**
 * The name of a regular backup.
 *
 * @param lineageId the lineage id of the copied database
 * @param at when the backup was made; the milliseconds are dropped
 * @param appliedMigrations the number of migrations applied to the copied database
 * @returns the file name
 */
export function backupFileName(lineageId: string, at: Date, appliedMigrations: number): string {
  return `assetforge-${lineageShortId(lineageId)}-${backupStamp(at)}-m${appliedMigrations}.sqlite`;
}

/**
 * Takes a regular backup name apart.
 *
 * @param name a file name
 * @returns its parts; null for any other name, also for a stamp that is no real date or time
 */
export function parseBackupName(name: string): ParsedBackupName | null {
  const match = BACKUP_NAME_PATTERN.exec(name);
  if (match === null) return null;
  const [, shortId, stamp, applied] = match as unknown as [string, string, string, string];
  const createdAt = stampToIso(stamp);
  if (createdAt === null) return null;
  return { name, lineageShortId: shortId, stamp, createdAt, appliedMigrations: Number(applied) };
}

/**
 * The UTC stamp of a backup name.
 *
 * @param at the time
 * @returns `yyyymmddThhmmssZ`
 */
function backupStamp(at: Date): string {
  return `${at.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;
}

/**
 * Reads a stamp back as a time, refusing what no real time writes (month 13, 31 February, hour 24).
 *
 * @param stamp `yyyymmddThhmmssZ`
 * @returns the ISO timestamp; null when the stamp is not a real time
 */
function stampToIso(stamp: string): string | null {
  const iso = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}.000Z`;
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return null;
  // `Date.parse` rolls some impossible dates over (31 February becomes 3 March); a round trip catches that.
  const roundTrip = new Date(time).toISOString();
  return roundTrip === iso ? roundTrip : null;
}
