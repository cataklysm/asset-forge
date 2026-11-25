export class AssetForgeError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
    this.name = new.target.name;
  }
}

function define(code: string) {
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
export class InvalidManifestError extends define('invalid_manifest') {}
export class NoWorkspaceOpenError extends define('no_workspace_open') {}
export class PathEscapeError extends define('path_escape') {}
export class SourceNotReadableError extends define('source_not_readable') {}
export class ChecksumMismatchError extends define('checksum_mismatch') {}
export class StorageAccessDeniedError extends define('storage_access_denied') {}
export class StorageFullError extends define('storage_full') {}
