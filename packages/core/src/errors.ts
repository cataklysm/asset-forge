import type { ErrorCode } from '@assetforge/contracts';

/**
 * An error whose code and message are forwarded to the renderer. The message never carries a cause, path, URL or
 * credential.
 */
export class AssetForgeError extends Error {
  /** The stable code the renderer acts on. */
  readonly code: ErrorCode;

  /**
   * @param code the stable code
   * @param message the fixed message shown to the user
   * @param options the cause, kept for logs only
   */
  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
    this.name = new.target.name;
  }
}

/**
 * The base class of the errors of one code.
 *
 * @param code the code
 * @returns a class that takes only the message and the cause
 */
function define(code: ErrorCode) {
  return class extends AssetForgeError {
    /**
     * @param message the fixed message shown to the user
     * @param options the cause, kept for logs only
     */
    constructor(message: string, options?: { cause?: unknown }) {
      super(code, message, options);
    }
  };
}

/** `workspace_not_found`: no workspace manifest in the directory. */
export class WorkspaceNotFoundError extends define('workspace_not_found') {}
/** `storage_unreachable`: the storage cannot be reached, as opposed to a missing file. */
export class StorageUnreachableError extends define('storage_unreachable') {}
/** `directory_not_empty`: a new workspace needs an empty directory. */
export class DirectoryNotEmptyError extends define('directory_not_empty') {}
/** `unsupported_format_version`: a manifest of a format this build does not read. */
export class UnsupportedFormatVersionError extends define('unsupported_format_version') {}
/** `workspace_mismatch`: the database belongs to another workspace than the manifest. */
export class WorkspaceMismatchError extends define('workspace_mismatch') {}
/** `workspace_duplicate`: the workspace is registered already. */
export class WorkspaceDuplicateError extends define('workspace_duplicate') {}
/** `trash_failed`: moving a workspace folder to the system trash failed. */
export class TrashFailedError extends define('trash_failed') {}
/** `invalid_manifest`: a manifest that cannot be parsed. */
export class InvalidManifestError extends define('invalid_manifest') {}
/** `no_workspace_open`: the request needs an open workspace. */
export class NoWorkspaceOpenError extends define('no_workspace_open') {}
/** `path_escape`: a path that would leave the workspace. */
export class PathEscapeError extends define('path_escape') {}
/** A source that is missing, not a regular file or not readable; the message never names the path. */
export class SourceNotReadableError extends AssetForgeError {
  /** @param options the cause, kept for logs only */
  constructor(options?: { cause?: unknown }) {
    super('source_not_readable', 'This file cannot be read', options);
  }
}
/** `checksum_mismatch`: the written bytes do not match the read ones. */
export class ChecksumMismatchError extends define('checksum_mismatch') {}
/** `storage_access_denied`: the storage refused the operation. */
export class StorageAccessDeniedError extends define('storage_access_denied') {}
/** `storage_full`: the storage has no space left. */
export class StorageFullError extends define('storage_full') {}
/** `not_found`: an unknown record. */
export class NotFoundError extends define('not_found') {}
/** `invalid_operation`: the request is valid but not allowed in the current state. */
export class InvalidOperationError extends define('invalid_operation') {}
/** `validation_failed`: an input that fails its rule. */
export class ValidationFailedError extends define('validation_failed') {}
/** No usable provider entry for a request: none exists, the one asked for is gone, or it has no model. */
export class ProviderNotConfiguredError extends define('provider_not_configured') {}

/** A readable source that is not a ZIP archive (or whose directory cannot be read). */
export class ArchiveNotReadableError extends ValidationFailedError {
  /** @param options the cause, kept for logs only */
  constructor(options?: { cause?: unknown }) {
    super('This file is not a readable ZIP archive', options);
  }
}

/** An archive that would take an import over its entry or size limit. */
export class ArchiveTooLargeError extends ValidationFailedError {
  /** @param options the cause, kept for logs only */
  constructor(options?: { cause?: unknown }) {
    super('This archive is too large to unpack', options);
  }
}

/** The fixed message of `CredentialStoreUnavailableError`. */
export const CREDENTIAL_STORE_UNAVAILABLE_MESSAGE =
  'The system credential store is not available, so the API key cannot be saved';

/** The OS credential store cannot encrypt, so a secret is not saved; there is no plaintext fallback. */
export class CredentialStoreUnavailableError extends AssetForgeError {
  /** @param options the cause, kept for logs only */
  constructor(options?: { cause?: unknown }) {
    super('credential_store_unavailable', CREDENTIAL_STORE_UNAVAILABLE_MESSAGE, options);
  }
}

/**
 * The text stored in `file.error` and returned to the renderer, for an import or a file move. Domain errors carry a
 * message written for that purpose; any other error (typically a Node fs error) may contain absolute paths, so only
 * its short error code survives.
 *
 * @param error the error that ended the step
 * @param fallback the text for an error that is not a domain error
 * @returns the message to store and show
 */
export function safeErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof AssetForgeError) return error.message;
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(code) ? `${fallback} (${code})` : fallback;
}
