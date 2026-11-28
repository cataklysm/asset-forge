import { describeError } from './error-description.js';

// The one format of a log line written through `LineLog`: a fixed event text, then `key=value` fields, then the
// safe description of an error. A field value is an id, a count, a code or a fixed word, never a path, a name, a
// URL or a message.

/** Writes one log line of the host (the main console in the app). Must not throw. */
export type LineLog = (line: string) => void;

/** The value of a field: an id, a count, a code or a fixed word; null leaves the field out. */
export type LogFieldValue = string | number | null;

/** A field value as it may appear in a line: letters, digits and the separators of ids, codes and channels. */
const SAFE_VALUE = /^[A-Za-z0-9 _.:-]{0,100}$/;

/** What a field value that fails `SAFE_VALUE` is written as. */
const UNSAFE_VALUE = '?';

/**
 * Formats one log line.
 *
 * @param event the fixed event text
 * @param fields the fields in the order they are written; a null value is left out
 * @returns the line, e.g. `Recovery on workspace open: workspace=<id> movesCompleted=2`
 */
export function logLine(event: string, fields: Readonly<Record<string, LogFieldValue>>): string {
  const parts = fieldParts(fields);
  return parts.length === 0 ? event : `${event}: ${parts.join(' ')}`;
}

/**
 * Formats one log line about an error: the fields, then the error's safe description.
 *
 * @param event the fixed event text
 * @param fields the fields in the order they are written; a null value is left out
 * @param error the error the line is about
 * @returns the line, e.g. `Import failed unexpectedly: operation=import file=<id> error=Error code=ENOSPC`
 */
export function errorLogLine(event: string, fields: Readonly<Record<string, LogFieldValue>>, error: unknown): string {
  return `${event}: ${[...fieldParts(fields), `error=${describeError(error)}`].join(' ')}`;
}

/**
 * The `key=value` parts of the fields.
 *
 * @param fields the fields; a null value is left out
 * @returns the parts in order
 */
function fieldParts(fields: Readonly<Record<string, LogFieldValue>>): string[] {
  return Object.entries(fields)
    .filter((entry): entry is [string, string | number] => entry[1] !== null)
    .map(([key, value]) => `${key}=${safeValue(value)}`);
}

/**
 * Writes a line, swallowing a failure of the log itself.
 *
 * @param log the log; nothing is written without one
 * @param line the line
 */
export function writeLine(log: LineLog | undefined, line: string): void {
  if (log === undefined) return;
  try {
    log(line);
  } catch {
    // A broken log must never fail the operation it reports on.
  }
}

/**
 * A field value as it is written.
 *
 * @param value the value
 * @returns a finite number or a string that passes `SAFE_VALUE`; anything else as `?`
 */
function safeValue(value: string | number): string {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : UNSAFE_VALUE;
  return SAFE_VALUE.test(value) ? value : UNSAFE_VALUE;
}
