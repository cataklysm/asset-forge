import type {
  FileKind,
  FileList,
  FileOrigin,
  FileRecord,
  FileRole,
  FileScope,
  ImportStatus,
} from '@assetforge/contracts';
import type { Page } from './page.js';

// The file rows of a workspace: the files themselves, the journal of their moves and the addresses they were
// downloaded from.

/** The file rows of a workspace, from the pending import to the purge. */
export interface FileRepository {
  /**
   * Inserts the pending row an import starts with, before anything is written to the storage.
   *
   * @param file the new row: its id, storage, original name, relative path, MIME type, import time and kind, and
   *   for a download its origin
   */
  insertPending(file: {
    id: string;
    storageId: string;
    originalName: string;
    relativePath: string;
    mimeType: string;
    importedAt: string;
    kind: FileKind;
    /**
     * A download's origin, written in the same transaction with created_at = importedAt; it marks the row as a
     * download.
     */
    origin?: { id: string; url: string };
  }): Promise<void>;
  /**
   * Deletes a pending row (its origins cascade).
   *
   * @param id the file
   * @returns false when the row is missing or not pending
   */
  deletePending(id: string): Promise<boolean>;
  /**
   * The pending rows of downloads.
   *
   * @returns the ids of pending rows that carry an origin
   */
  listPendingDownloadIds(): Promise<string[]>;
  /**
   * Marks a row complete once its content is verified and in place; rejects with NotFoundError for an unknown id.
   *
   * @param id the file
   * @param content the size, checksum and pixel size (null where it does not apply) of the stored content
   */
  markComplete(
    id: string,
    content: { sizeBytes: number; sha256: string; width: number | null; height: number | null },
  ): Promise<void>;
  /**
   * Stores the pixel size, and the duration when `durationMs` is given (a video); rejects with NotFoundError for an
   * unknown id.
   *
   * @param id the file
   * @param size the pixel size and, for a video, the duration
   * @returns the updated record
   */
  setDimensions(id: string, size: { width: number; height: number; durationMs?: number | null }): Promise<FileRecord>;
  /**
   * Marks a row failed; rejects with NotFoundError for an unknown id.
   *
   * @param id the file
   * @param error the fixed message stored in `file.error`
   */
  markFailed(id: string, error: string): Promise<void>;
  /**
   * The files with identical content, for duplicate detection.
   *
   * @param sha256 the checksum
   * @returns complete files outside the trash with this checksum, oldest import first, then id; a trashed file is no
   *   duplicate
   */
  findCompleteBySha256(sha256: string): Promise<FileRecord[]>;
  /**
   * Every file in one import status.
   *
   * @param status the import status
   * @returns the records
   */
  listByStatus(status: ImportStatus): Promise<FileRecord[]>;
  /**
   * One file.
   *
   * @param id the file
   * @returns the record; null for an unknown id
   */
  get(id: string): Promise<FileRecord | null>;
  /**
   * Points the row at a new path, asset and role. Rejects with NotFoundError for an unknown id and with
   * InvalidOperationError for a file in the trash (only a `restore` move places it again). Clears the chosen cover of
   * any other asset than `placement.assetId` that uses this file.
   *
   * @param id the file
   * @param placement the new path, asset and role
   * @returns the updated record
   */
  setPlacement(id: string, placement: FilePlacement): Promise<FileRecord>;
  /**
   * One page of files, newest importedAt first; in the trash newest deletion first. Every scope but `trash` leaves
   * out the files in the trash.
   *
   * @param filter the scope, the filters and the page
   * @returns the page and the total
   */
  list(filter: FileQuery): Promise<FileList>;
  /**
   * One transaction: deletes the file row and every row that references it, only for a row that is
   * in the trash or has status `failed`. Rejects with InvalidOperationError and deletes nothing while the file has
   * an open `file_move` row or a running `image.generate` job (`RUNNING_GENERATION_MESSAGE`). For a
   * trashed file the same transaction writes a purge tombstone (`file_purge`).
   *
   * @param id the file
   * @returns false when the row is neither trashed nor failed, and for an unknown id
   */
  purge(id: string): Promise<boolean>;
  /**
   * The purged trashed files whose binary may still be on the storage.
   *
   * @returns the ids of purged trashed files whose tombstone is still there, ascending
   */
  listPurgedIds(): Promise<string[]>;
  /**
   * Deletes the purge tombstone of a file; no-op without one.
   *
   * @param id the file
   */
  forgetPurge(id: string): Promise<void>;
  /**
   * The size of the trash.
   *
   * @returns how many files are in the trash
   */
  countTrashed(): Promise<number>;
  /**
   * The whole trash.
   *
   * @returns the ids of every file in the trash, newest deletion first
   */
  listTrashedIds(): Promise<string[]>;
}

/** What a file list asks for: the scope, the filters and the page. */
export interface FileQuery extends Page {
  /** Which files the list covers: all, the inbox, one asset or the trash. */
  scope: FileScope;
  /**
   * Free text; every word must be a substring of the folded file name or a word prefix of one of its tags. Absent
   * when the text has no words.
   */
  query?: string;
  /** Normalised, distinct tag names; each must be on the file itself. */
  tagNames?: string[];
  /** Only files with this role. */
  role?: FileRole;
  /** Only files of this kind. */
  kind?: FileKind;
  /** Only files with (true) or without (false) a waiting tag proposal. */
  hasProposal?: boolean;
  /** Only these files, within the scope and every other filter. */
  ids?: readonly string[];
}

/** Where a file row points: its path and, unless it is in the inbox, its asset and role. */
export interface FilePlacement {
  /** The path relative to the storage root. */
  relativePath: string;
  /** The asset; null in the inbox. */
  assetId: string | null;
  /** The role in the asset; null in the inbox. */
  role: FileRole | null;
}

/** What the commit of a move does: place the file, send it to the trash, or bring it back from there. */
export type FileMoveKind = 'relocate' | 'trash' | 'restore';

/** Journal entry of a file move in progress: written before the file moves, removed with the commit. */
export interface FileMove {
  /** The file being moved. */
  fileId: string;
  /** What the commit does. */
  kind: FileMoveKind;
  /** The path the file moves to, relative to the storage root. */
  targetRelativePath: string;
  /** The asset after the move; null for the inbox and the trash. */
  targetAssetId: string | null;
  /** The role after the move; null for the inbox and the trash. */
  targetRole: FileRole | null;
  /** When the move began. */
  createdAt: string;
}

/** The journal that makes a file move recoverable: a row while the binary moves, gone with the commit. */
export interface FileMoveRepository {
  /**
   * Writes the journal row before the binary moves; rejects with InvalidOperationError if the file already has a
   * move row.
   *
   * @param move the journal entry
   */
  begin(move: FileMove): Promise<void>;
  /**
   * One transaction: copy the target into the file row, clear the chosen cover of any other asset
   * than the target that uses this file, delete the move row. NotFoundError if there is no move row. Refused with
   * InvalidOperationError, writing nothing, when the kind does not fit the file: a `relocate` or `trash` of a file in
   * the trash, a `restore` of one outside it.
   *
   * @param fileId the file
   * @returns the updated record
   */
  commit(fileId: string): Promise<FileRecord>;
  /**
   * Deletes the journal row without applying it; no-op if missing.
   *
   * @param fileId the file
   */
  abort(fileId: string): Promise<void>;
  /**
   * Every open move, for the recovery on open.
   *
   * @returns the journal entries by createdAt, then fileId
   */
  list(): Promise<FileMove[]>;
}

/**
 * Web addresses a file was downloaded from; a file carries a URL at most once and at most MAX_FILE_ORIGINS.
 * The rows go with the file when it is purged; trash and restore keep them.
 */
export interface FileOriginRepository {
  /**
   * The origins of one file.
   *
   * @param fileId the file
   * @returns its origins by createdAt, then id
   */
  listByFile(fileId: string): Promise<FileOrigin[]>;
  /**
   * One origin with the file it belongs to.
   *
   * @param id the origin
   * @returns the origin; null for an unknown id
   */
  get(id: string): Promise<(FileOrigin & { fileId: string }) | null>;
  /**
   * The file a URL was already downloaded into.
   *
   * @param url the address as stored
   * @returns the oldest complete file (trash included) that carries this URL; null when none
   */
  findCompleteFileByUrl(url: string): Promise<string | null>;
  /**
   * Which of several URLs were already downloaded.
   *
   * @param urls the addresses as stored
   * @returns those carried by a complete file (trash included)
   */
  knownUrls(urls: readonly string[]): Promise<Set<string>>;
  /**
   * Adds an origin to a file.
   *
   * @param origin the new row
   * @returns false, writing nothing, when the file already has this URL or already carries MAX_FILE_ORIGINS
   */
  insert(origin: { id: string; fileId: string; url: string; createdAt: string }): Promise<boolean>;
}
