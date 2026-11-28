import type { AnalysisPreview, AnalysisTarget } from '@assetforge/contracts';

/** Provenance of the latest analysis of a file: the content that was analysed, by what and when. */
export interface FileAnalysis {
  fileId: string;
  sha256: string;
  provider: string;
  model: string;
  promptVersion: number;
  /** Name of the analysis prompt used, as it was then; null for analyses from before analysis prompts. */
  promptName: string | null;
  analysedAt: string;
}

/** What an analysis result depends on besides the file content: equal fingerprints and hash mean "already analysed". */
export interface AnalysisFingerprint {
  provider: string;
  model: string;
  promptVersion: number;
}

/** A tag proposal of an analysis in mode `propose`, waiting for the owner; one per file. */
export interface Proposal extends AnalysisFingerprint {
  fileId: string;
  /** Hash of the content that was analysed. */
  sha256: string;
  /** Already cleaned, at most 50. */
  tags: { name: string; displayName: string }[];
  /** Name of the analysis prompt used, as it was then; null for proposals from before analysis prompts. */
  promptName: string | null;
  createdAt: string;
}

export interface FileAnalysisRepository {
  get(fileId: string): Promise<FileAnalysis | null>;
  /**
   * One transaction. Returns false and writes nothing unless the file exists, is complete and has
   * this sha256. Otherwise: deletes every `ai` assignment of the file, inserts an `ai` assignment
   * for each tag the file does not carry manually (creating missing tags), upserts the analysis
   * row, deletes a waiting proposal of the file and reindexes the file's asset.
   */
  apply(r: {
    fileId: string;
    sha256: string;
    tags: readonly { name: string; displayName: string; newId: string }[];
    provider: string;
    model: string;
    promptVersion: number;
    /** Recorded on the analysis row; not part of the fingerprint. */
    promptName: string | null;
    now: string;
  }): Promise<boolean>;
  /**
   * One transaction. Returns false and writes nothing unless the file exists, is complete and has
   * this sha256; otherwise stores the proposal, replacing an older one. Tags and the analysis row stay untouched.
   */
  propose(r: Proposal): Promise<boolean>;
  /** The waiting proposal; `stale` when the file's current sha256 differs from the proposal's. */
  getProposal(fileId: string): Promise<(Proposal & { stale: boolean }) | null>;
  /**
   * One transaction. False when there is no proposal or it is stale (the file is gone, not complete
   * or its sha256 differs from `sha256` / the proposal's; a stale proposal is deleted). Otherwise applies
   * exactly `tags` as `apply` does, writes the analysis row from the proposal's fingerprint and prompt name with
   * `analysedAt = now`, deletes the proposal and returns true.
   */
  acceptProposal(r: {
    fileId: string;
    sha256: string;
    tags: readonly { name: string; displayName: string; newId: string }[];
    now: string;
  }): Promise<boolean>;
  /** Deletes the proposal; no-op without one. */
  discardProposal(fileId: string): Promise<void>;
}

/** One file of an analysis target. */
export interface AnalysisTargetEntry {
  fileId: string;
  /** Complete, of one of the given MIME types, with a checksum (core's `isAnalysable`). */
  analysable: boolean;
  /** The fingerprint and the file's current sha256 equal its analysis row or its waiting proposal. */
  analysed: boolean;
}

/**
 * Enumerates the files of an analysis target in the main process, so the id set never crosses IPC.
 * `asset`: every file of the asset. `assetFilter`: the files of the matching assets, only those with
 * the filter's `fileRole` / `fileKind` when set; `query` and `tagNames` select assets only.
 */
export interface AnalysisTargetReader {
  /** Keyset page by file id, ascending, after `afterId`; unknown ids of a `files` target are absent. */
  page(r: {
    target: AnalysisTarget;
    fingerprint: AnalysisFingerprint;
    mimeTypes: readonly string[];
    afterId: string | null;
    limit: number;
  }): Promise<AnalysisTargetEntry[]>;
  /**
   * Disjoint counts over the whole target, for `analysis:preview`: `notAnalysable` the files that are
   * not analysable; of the analysable ones `alreadyAnalysed` those analysed with the fingerprint,
   * `alreadyQueued` the rest with an active `vision.analyze_file` job, `analysable` the remainder
   * (what an enqueue without `force` would queue). Unknown ids of a `files` target are not counted.
   */
  count(r: { target: AnalysisTarget; fingerprint: AnalysisFingerprint; mimeTypes: readonly string[] }): Promise<AnalysisPreview>;
}
