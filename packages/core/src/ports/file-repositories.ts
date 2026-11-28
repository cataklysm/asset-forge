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

export interface FileRepository {
  insertPending(r: {
    id: string;
    storageId: string;
    originalName: string;
    relativePath: string;
    mimeType: string;
    importedAt: string;
    kind: FileKind;
    /** A download's origin, written in the same transaction with created_at = importedAt; it marks the row as a download. */
    origin?: { id: string; url: string };
  }): Promise<void>;
  /** Deletes a pending row (its origins cascade). False when the row is missing or not pending. */
  deletePending(id: string): Promise<boolean>;
  /** Ids of pending rows that carry an origin. */
  listPendingDownloadIds(): Promise<string[]>;
  markComplete(id: string, r: { sizeBytes: number; sha256: string; width: number | null; height: number | null }): Promise<void>; // rejects with NotFoundError for an unknown id
  /**
   * Stores the pixel size, and the duration when `durationMs` is given (a video); rejects with NotFoundError for an
   * unknown id.
   */
  setDimensions(id: string, size: { width: number; height: number; durationMs?: number | null }): Promise<FileRecord>;
  markFailed(id: string, error: string): Promise<void>; // rejects with NotFoundError for an unknown id
  /** Complete files outside the trash with this checksum, oldest import first, then id. */
  findCompleteBySha256(sha256: string): Promise<FileRecord[]>;
  listByStatus(status: ImportStatus): Promise<FileRecord[]>;
  get(id: string): Promise<FileRecord | null>;
  /** Rejects with NotFoundError for an unknown id. Clears the chosen cover of any other asset than `placement.assetId` that uses this file. */
  setPlacement(id: string, placement: FilePlacement): Promise<FileRecord>;
  list(q: FileQuery): Promise<FileList>; // newest importedAt first
  /**
   * One transaction: deletes the file row and every row that references it, only for a row that is
   * in the trash or has status `failed`. False otherwise and for an unknown id. Rejects with
   * InvalidOperationError and deletes nothing while the file has an open `file_move` row or a running
   * `image.generate` job (`RUNNING_GENERATION_MESSAGE`). For a
   * trashed file the same transaction writes a purge tombstone (`file_purge`).
   */
  purge(id: string): Promise<boolean>;
  /** The ids of purged trashed files whose tombstone is still there, ascending. */
  listPurgedIds(): Promise<string[]>;
  /** Deletes the purge tombstone of `id`; no-op without one. */
  forgetPurge(id: string): Promise<void>;
  /** How many files are in the trash. */
  countTrashed(): Promise<number>;
  /** The ids of every file in the trash, newest deletion first. */
  listTrashedIds(): Promise<string[]>;
}

export interface FileQuery extends Page {
  scope: FileScope;
  /** Free text; every word must be a substring of the folded file name or a word prefix of one of its tags. Absent when the text has no words. */
  query?: string;
  /** Normalised, distinct tag names; each must be on the file itself. */
  tagNames?: string[];
  role?: FileRole;
  kind?: FileKind;
  /** Only files with (true) or without (false) a waiting tag proposal. */
  hasProposal?: boolean;
  /** Only these files, within the scope and every other filter. */
  ids?: readonly string[];
}

/** Where a file row points: its path and, unless it is in the inbox, its asset and role. */
export interface FilePlacement {
  relativePath: string;
  assetId: string | null;
  role: FileRole | null;
}

/** What the commit of a move does: place the file, send it to the trash, or bring it back from there. */
export type FileMoveKind = 'relocate' | 'trash' | 'restore';

/** Journal entry of a file move in progress: written before the file moves, removed with the commit. */
export interface FileMove {
  fileId: string;
  kind: FileMoveKind;
  targetRelativePath: string;
  targetAssetId: string | null;
  targetRole: FileRole | null;
  createdAt: string;
}

export interface FileMoveRepository {
  begin(move: FileMove): Promise<void>; // rejects with InvalidOperationError if the file already has a move row
  /**
   * One transaction: copy the target into the file row, clear the chosen cover of any other asset
   * than the target that uses this file, delete the move row. NotFoundError if there is no move row.
   */
  commit(fileId: string): Promise<FileRecord>;
  abort(fileId: string): Promise<void>; // no-op if missing
  list(): Promise<FileMove[]>; // by createdAt, then fileId
}

/**
 * Web addresses a file was downloaded from; a file carries a URL at most once and at most MAX_FILE_ORIGINS.
 * The rows go with the file when it is purged; trash and restore keep them.
 */
export interface FileOriginRepository {
  listByFile(fileId: string): Promise<FileOrigin[]>; // by createdAt, then id
  get(id: string): Promise<(FileOrigin & { fileId: string }) | null>;
  /** The oldest complete file (trash included) that carries this URL; null when none. */
  findCompleteFileByUrl(url: string): Promise<string | null>;
  /** Of `urls`, those carried by a complete file (trash included). */
  knownUrls(urls: readonly string[]): Promise<Set<string>>;
  /** False, writing nothing, when the file already has this URL or already carries MAX_FILE_ORIGINS. */
  insert(row: { id: string; fileId: string; url: string; createdAt: string }): Promise<boolean>;
}
