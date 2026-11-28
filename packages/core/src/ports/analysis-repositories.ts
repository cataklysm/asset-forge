import type { AnalysisPreview, AnalysisTarget } from '@assetforge/contracts';

// The AI analysis of a workspace: the record of the latest analysis per file, the waiting tag proposals and the
// enumeration of the files an analysis start covers.

/** Provenance of the latest analysis of a file: the content that was analysed, by what and when. */
export interface FileAnalysis {
  /** The analysed file. */
  fileId: string;
  /** Hash of the content that was analysed. */
  sha256: string;
  /** The fingerprint provider id (the adapter kind, not the entry). */
  provider: string;
  /** The model that answered. */
  model: string;
  /** `ANALYSIS_PROMPT_VERSION` at the time. */
  promptVersion: number;
  /** Name of the analysis prompt used, as it was then; null for analyses from before analysis prompts. */
  promptName: string | null;
  /** When the result was applied. */
  analysedAt: string;
}

/** What an analysis result depends on besides the file content: equal fingerprints and hash mean "already analysed". */
export interface AnalysisFingerprint {
  /** The fingerprint provider id (the adapter kind, not the entry). */
  provider: string;
  /** The model. */
  model: string;
  /** `ANALYSIS_PROMPT_VERSION`. */
  promptVersion: number;
}

/** A tag proposal of an analysis in mode `propose`, waiting for the owner; one per file. */
export interface Proposal extends AnalysisFingerprint {
  /** The analysed file. */
  fileId: string;
  /** Hash of the content that was analysed. */
  sha256: string;
  /** Already cleaned, at most 50. */
  tags: { name: string; displayName: string }[];
  /** Name of the analysis prompt used, as it was then; null for proposals from before analysis prompts. */
  promptName: string | null;
  /** When the proposal was stored. */
  createdAt: string;
}

/** What accepting a proposal did: applied it, found none, found it out of date, or found the file in the trash. */
export type ProposalAcceptance = 'accepted' | 'missing' | 'stale' | 'trashed';

/** The analysis records and tag proposals of the files. */
export interface FileAnalysisRepository {
  /**
   * The latest analysis of a file.
   *
   * @param fileId the file
   * @returns the record; null when the file was never analysed
   */
  get(fileId: string): Promise<FileAnalysis | null>;
  /**
   * One transaction. Writes nothing unless the file exists, is complete, is not in the trash and has this sha256.
   * Otherwise: deletes every `ai` assignment of the file, inserts an `ai` assignment for each tag the file does not
   * carry manually (creating missing tags), upserts the analysis row, deletes a waiting proposal of the file and
   * reindexes the file's asset.
   *
   * @param result the file, the analysed hash, the tags with an id for a new tag row each, the fingerprint, the prompt
   *   name and the time
   * @returns false when nothing was written
   */
  apply(result: {
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
   * One transaction. Writes nothing unless the file exists, is complete, is not in the trash and has this sha256;
   * otherwise stores the proposal, replacing an older one. Tags and the analysis row stay untouched.
   *
   * @param proposal the proposal
   * @returns false when nothing was written
   */
  propose(proposal: Proposal): Promise<boolean>;
  /**
   * The waiting proposal of a file.
   *
   * @param fileId the file
   * @returns the proposal, `stale` when the file's current sha256 differs from the proposal's; null without one
   */
  getProposal(fileId: string): Promise<(Proposal & { stale: boolean }) | null>;
  /**
   * One transaction, checked in this order: `missing` without a proposal; `trashed`, writing nothing, for a file in
   * the trash, which keeps its proposal for a restore; `stale` and the proposal deleted when the file is gone, not
   * complete or its current sha256 differs from the proposal's; `stale` without deleting anything when `sha256`
   * differs from the proposal's or `tags` is empty or holds a name outside the proposal (the caller read an older
   * proposal). Otherwise applies exactly `tags` as `apply` does, writes the analysis row from the proposal's
   * fingerprint and prompt name with `analysedAt = now`, deletes the proposal and answers `accepted`.
   *
   * @param acceptance the file, the hash the owner saw, the accepted tags with an id for a new tag row each and the
   *   time
   * @returns what happened
   */
  acceptProposal(acceptance: {
    fileId: string;
    sha256: string;
    tags: readonly { name: string; displayName: string; newId: string }[];
    now: string;
  }): Promise<ProposalAcceptance>;
  /**
   * Deletes the proposal; no-op without one.
   *
   * @param fileId the file
   */
  discardProposal(fileId: string): Promise<void>;
}

/** One file of an analysis target. */
export interface AnalysisTargetEntry {
  /** The file. */
  fileId: string;
  /** Complete, not in the trash, of one of the given MIME types, with a checksum (core's `isAnalysable`). */
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
  /**
   * Keyset page by file id, ascending, after `afterId`; unknown ids of a `files` target are absent.
   *
   * @param request the target, the fingerprint, the analysable MIME types, the last id of the previous page (null for
   *   the first) and the page size
   * @returns the entries of the page
   */
  page(request: {
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
   *
   * @param request the target, the fingerprint and the analysable MIME types
   * @returns the four counts
   */
  count(request: {
    target: AnalysisTarget;
    fingerprint: AnalysisFingerprint;
    mimeTypes: readonly string[];
  }): Promise<AnalysisPreview>;
}
