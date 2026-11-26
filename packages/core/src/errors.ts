import type { ErrorCode } from '@assetforge/contracts';

export class AssetForgeError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
    this.name = new.target.name;
  }
}

function define(code: ErrorCode) {
  return class extends AssetForgeError {
    constructor(message: string, options?: { cause?: unknown }) {
      super(code, message, options);
    }
  };
}

export class WorkspaceNotFoundError extends define('workspace_not_found') {}
export class StorageUnreachableError extends define('storage_unreachable') {}
export class DirectoryNotEmptyError extends define('directory_not_empty') {}
export class UnsupportedFormatVersionError extends define('unsupported_format_version') {}
export class WorkspaceMismatchError extends define('workspace_mismatch') {}
export class WorkspaceDuplicateError extends define('workspace_duplicate') {}
export class TrashFailedError extends define('trash_failed') {}
export class InvalidManifestError extends define('invalid_manifest') {}
export class NoWorkspaceOpenError extends define('no_workspace_open') {}
export class PathEscapeError extends define('path_escape') {}
/** A source that is missing, not a regular file or not readable; the message never names the path. */
export class SourceNotReadableError extends AssetForgeError {
  constructor(options?: { cause?: unknown }) {
    super('source_not_readable', 'This file cannot be read', options);
  }
}
export class ChecksumMismatchError extends define('checksum_mismatch') {}
export class StorageAccessDeniedError extends define('storage_access_denied') {}
export class StorageFullError extends define('storage_full') {}
export class NotFoundError extends define('not_found') {}
export class InvalidOperationError extends define('invalid_operation') {}
export class ValidationFailedError extends define('validation_failed') {}
/** No usable provider entry for a request: none exists, the one asked for is gone, or it has no model. */
export class ProviderNotConfiguredError extends define('provider_not_configured') {}

/** A readable source that is not a ZIP archive (or whose directory cannot be read). */
export class ArchiveNotReadableError extends ValidationFailedError {
  constructor(options?: { cause?: unknown }) {
    super('This file is not a readable ZIP archive', options);
  }
}

/** An archive that would take an import over its entry or size limit. */
export class ArchiveTooLargeError extends ValidationFailedError {
  constructor(options?: { cause?: unknown }) {
    super('This archive is too large to unpack', options);
  }
}

export const CREDENTIAL_STORE_UNAVAILABLE_MESSAGE = 'The system credential store is not available, so the API key cannot be saved';

/** The OS credential store cannot encrypt, so a secret is not saved; there is no plaintext fallback. */
export class CredentialStoreUnavailableError extends AssetForgeError {
  constructor(options?: { cause?: unknown }) {
    super('credential_store_unavailable', CREDENTIAL_STORE_UNAVAILABLE_MESSAGE, options);
  }
}
