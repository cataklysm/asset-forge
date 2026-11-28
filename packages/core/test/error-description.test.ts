import { describe, expect, it } from 'vitest';
import { describeError, isUnexpectedError } from '../src/error-description.js';
import {
  AssetForgeError,
  JobError,
  RemoteFileError,
  SourceNotReadableError,
  StorageFullError,
  ValidationFailedError,
} from '../src/index.js';

const MARKER = 'SECRET_PATH_MARKER';
const WINDOWS_PATH = `C:\\Users\\someone\\${MARKER}\\photo.png`;
const POSIX_PATH = `/home/someone/${MARKER}/photo.png`;

/**
 * A Node-style system error whose message, path and stack all name a path.
 *
 * @param code the system code
 * @param syscall the syscall
 * @returns the error
 */
function systemError(code: unknown, syscall: unknown): Error {
  const error = new Error(`${String(code)}: no such file or directory, open '${WINDOWS_PATH}'`) as Error & {
    code?: unknown;
    syscall?: unknown;
    path?: string;
    dest?: string;
  };
  error.code = code;
  error.syscall = syscall;
  error.path = WINDOWS_PATH;
  error.dest = POSIX_PATH;
  error.stack = `Error: open '${WINDOWS_PATH}'\n    at open (${POSIX_PATH}:1:1)`;
  return error;
}

describe('describeError', () => {
  it('keeps the class name, the system code and the syscall of a Node error', () => {
    expect(describeError(systemError('ENOSPC', 'write'))).toBe('Error code=ENOSPC syscall=write');
  });

  it('never carries the message, the path, the destination or the stack', () => {
    const description = describeError(systemError('ENOENT', 'open'));
    expect(description).not.toContain(MARKER);
    expect(description).not.toContain('photo');
    expect(description).not.toContain('\\');
    expect(description).not.toContain('/');
    expect(description).not.toContain('no such file');
  });

  it('keeps SQLite codes and long Node codes', () => {
    expect(describeError(systemError('SQLITE_BUSY', undefined))).toBe('Error code=SQLITE_BUSY');
    expect(describeError(systemError('ERR_STREAM_PREMATURE_CLOSE', undefined))).toBe(
      'Error code=ERR_STREAM_PREMATURE_CLOSE',
    );
  });

  it('drops a code that is not a short upper-case token', () => {
    for (const code of [WINDOWS_PATH, 'enoent', 'E NOENT', 'E'.repeat(49), 42, '', `EPERM ${MARKER}`]) {
      const description = describeError(systemError(code, undefined));
      expect(description).toBe('Error');
    }
  });

  it('drops a syscall that is not a short lower-case token', () => {
    expect(describeError(systemError('EPERM', POSIX_PATH))).toBe('Error code=EPERM');
    expect(describeError(systemError('EPERM', 'Open'))).toBe('Error code=EPERM');
  });

  it('keeps a well-formed class name and replaces any other', () => {
    expect(describeError(new TypeError(WINDOWS_PATH))).toBe('TypeError');
    const renamed = new Error('x');
    renamed.name = WINDOWS_PATH;
    expect(describeError(renamed)).toBe('Error');
  });

  it('keeps the domain code of an AssetForgeError, never its message', () => {
    const error = new ValidationFailedError(`Bad ${MARKER}`);
    expect(describeError(error)).toBe('ValidationFailedError code=validation_failed');
  });

  it('follows the cause of a domain error one level', () => {
    const error = new SourceNotReadableError({ cause: systemError('ENOENT', 'open') });
    expect(describeError(error)).toBe(
      'SourceNotReadableError code=source_not_readable cause=(Error code=ENOENT syscall=open)',
    );
    const nested = new StorageFullError('full', {
      cause: new StorageFullError('inner', { cause: systemError('ENOSPC', 'write') }),
    });
    expect(describeError(nested)).toBe('StorageFullError code=storage_full cause=(StorageFullError code=storage_full)');
  });

  it('does not follow the cause of a foreign error', () => {
    const error = new Error('outer', { cause: systemError('ENOENT', 'open') });
    expect(describeError(error)).toBe('Error');
  });

  it('keeps the code of a job error', () => {
    expect(describeError(new JobError('download_no_space'))).toBe('JobError code=download_no_space');
  });

  it('describes a value that is not an error by its type only', () => {
    expect(describeError(WINDOWS_PATH)).toBe('non-error string');
    expect(describeError({ message: WINDOWS_PATH, code: 'ENOENT' })).toBe('non-error object');
    expect(describeError(null)).toBe('non-error null');
    expect(describeError(undefined)).toBe('non-error undefined');
    expect(describeError(7)).toBe('non-error number');
  });

  it('never throws, also for an error whose properties throw', () => {
    const hostile = new Error('x');
    Object.defineProperty(hostile, 'code', {
      get() {
        throw new Error(WINDOWS_PATH);
      },
    });
    expect(describeError(hostile)).toBe('unreadable error');
  });
});

describe('isUnexpectedError', () => {
  it('counts foreign errors and values as unexpected', () => {
    expect(isUnexpectedError(systemError('ENOSPC', 'write'))).toBe(true);
    expect(isUnexpectedError(new TypeError('x'))).toBe(true);
    expect(isUnexpectedError('x')).toBe(true);
  });

  it('counts domain, job, remote and abort errors as expected', () => {
    expect(isUnexpectedError(new AssetForgeError('not_found', 'x'))).toBe(false);
    expect(isUnexpectedError(new JobError('internal_error'))).toBe(false);
    expect(isUnexpectedError(new RemoteFileError('unreachable'))).toBe(false);
    expect(isUnexpectedError(new DOMException('aborted', 'AbortError'))).toBe(false);
  });
});
