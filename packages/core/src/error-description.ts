import { AssetForgeError } from './errors.js';
import { JobError } from './job-types.js';
import { RemoteFileError } from './ports/remote-files.js';

// The safe description of an error for a log line. A log line never holds a path, a file name, a URL, a host, a
// credential, a cookie, prompt or tag text, an error message or a stack: messages of Node and SQLite errors name
// paths. What survives is the class name, a code and the syscall, each only when it is a short token.

/** A class name such as `TypeError` or `StorageFullError`. */
const NAME_TOKEN = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
/** A system error code such as `ENOSPC`, `EPERM`, `SQLITE_BUSY` or `ERR_STREAM_PREMATURE_CLOSE`. */
const SYSTEM_CODE_TOKEN = /^[A-Z][A-Z0-9_]{0,47}$/;
/** The code of a domain or job error, such as `storage_full` or `download_no_space`. */
const DOMAIN_CODE_TOKEN = /^[a-z][a-z0-9_]{0,63}$/;
/** A syscall name such as `open`, `rename` or `write`. */
const SYSCALL_TOKEN = /^[a-z][a-z0-9_]{0,31}$/;

/** How deep the causes of a domain error are followed. */
const MAX_CAUSE_DEPTH = 1;

/**
 * The safe description of an error: its class name, then `code=<code>` and `syscall=<syscall>` when present and
 * well-formed, then `cause=(<description>)` for the cause of a domain or job error. A value that is not an `Error`
 * is described by its type only.
 *
 * @param error what was thrown or rejected with
 * @returns the description, never a message, path, URL or stack; never throws
 */
export function describeError(error: unknown): string {
  try {
    return describeAtDepth(error, 0);
  } catch {
    // A getter that throws (a proxy, a broken subclass) must not turn the log line into a second failure.
    return 'unreadable error';
  }
}

/**
 * Whether an error is one the code did not expect: anything but a domain error, a job error, a typed failure of
 * the remote source and an abort. Expected errors already carry a code the user sees.
 *
 * @param error what was thrown or rejected with
 * @returns true for an unexpected error
 */
export function isUnexpectedError(error: unknown): boolean {
  if (error instanceof AssetForgeError || error instanceof JobError || error instanceof RemoteFileError) return false;
  return !(error instanceof Error && error.name === 'AbortError');
}

/**
 * The description of an error found at a depth of the cause chain.
 *
 * @param error the error
 * @param depth 0 for the error itself, 1 for its cause
 * @returns the description
 */
function describeAtDepth(error: unknown, depth: number): string {
  if (!(error instanceof Error)) return `non-error ${error === null ? 'null' : typeof error}`;
  const parts = [NAME_TOKEN.test(error.name) ? error.name : 'Error'];
  const code = codeOf(error);
  if (code !== null) parts.push(`code=${code}`);
  const syscall = tokenOf(error, 'syscall', SYSCALL_TOKEN);
  if (syscall !== null) parts.push(`syscall=${syscall}`);
  if (depth < MAX_CAUSE_DEPTH && hasDomainCode(error) && error.cause !== undefined) {
    parts.push(`cause=(${describeAtDepth(error.cause, depth + 1)})`);
  }
  return parts.join(' ');
}

/**
 * The code of an error: the stable code of a domain or job error, else a system error code.
 *
 * @param error the error
 * @returns the code; null when there is none or it is not a short token
 */
function codeOf(error: Error): string | null {
  if (hasDomainCode(error)) return tokenOf(error, 'code', DOMAIN_CODE_TOKEN);
  return tokenOf(error, 'code', SYSTEM_CODE_TOKEN);
}

/**
 * Whether the error carries a code of the app's own vocabulary.
 *
 * @param error the error
 * @returns true for a domain or job error
 */
function hasDomainCode(error: Error): boolean {
  return error instanceof AssetForgeError || error instanceof JobError;
}

/**
 * One string property of an error, when it matches its token rule.
 *
 * @param error the error
 * @param key the property
 * @param token the rule the value must match completely
 * @returns the value; null when it is missing, not a string or does not match
 */
function tokenOf(error: Error, key: 'code' | 'syscall', token: RegExp): string | null {
  const value = (error as { code?: unknown; syscall?: unknown })[key];
  return typeof value === 'string' && token.test(value) ? value : null;
}
