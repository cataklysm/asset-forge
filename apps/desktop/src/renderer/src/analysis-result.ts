import type { Dispatch, SetStateAction } from 'react';
import {
  ACTIVE_JOB_STATUSES,
  JOB_ERROR_MESSAGES,
  type IpcResponse,
  type JobView,
  type ProposalView,
} from '@assetforge/contracts';

/** The message of a failed job that carries neither a message nor a code. */
const FAILED_FALLBACK = JOB_ERROR_MESSAGES.internal_error;

/** The stored proposal and the newest job of one file, as `analysis:getProposal` answers them. */
export type Stored = IpcResponse<'analysis:getProposal'>;

/** One AI tag a finished batch analysis applied. */
export interface AppliedTag {
  name: string;
  displayName: string;
}

/** What the result dialog shows for one file. */
export interface Shown {
  fileId: string;
  proposal: ProposalView | null;
  job: JobView | null;
  /** Names switched off; they belong to exactly this proposal. */
  off: ReadonlySet<string>;
  /** The file's AI tags after a finished batch analysis (`appliedByBatch`); null otherwise. */
  applied: readonly AppliedTag[] | null;
}

/**
 * Whether the job is an analysis started elsewhere, which applies its tags instead of proposing them.
 *
 * @param job the job; null for none
 * @returns true for a job in mode `apply`
 */
export const isBatchJob = (job: JobView | null) => job !== null && job.mode === 'apply';

/**
 * Whether what was read is the end of a batch analysis: its job succeeded and no proposal waits, so the file's AI
 * tags are its result.
 *
 * @param stored the proposal and the newest job
 * @returns true when the applied tags are to be shown
 */
export function appliedByBatch(stored: Stored): boolean {
  return stored.proposal === null && isBatchJob(stored.job) && stored.job?.status === 'succeeded';
}

/** No name switched off. */
const NO_OFF: ReadonlySet<string> = new Set();

/**
 * Identifies one stored proposal: a replaced proposal never shares the key of the one before.
 *
 * @param proposal the proposal; null for none
 * @returns the key, or null for none
 */
export function proposalKey(proposal: ProposalView | null): string | null {
  if (proposal === null) return null;
  return JSON.stringify([
    proposal.model,
    proposal.promptName,
    proposal.createdAt,
    proposal.tags.map((tag) => tag.name),
  ]);
}

/**
 * Whether the job is still queued or running.
 *
 * @param job the job; null for none
 * @returns true while it is active
 */
export const isActive = (job: JobView | null) =>
  job !== null && (ACTIVE_JOB_STATUSES as readonly string[]).includes(job.status);

/**
 * Whether ISO time `time` is later than `other`.
 *
 * @param time the one time
 * @param other the other time
 * @returns true when `time` is later
 */
const newer = (time: string, other: string) => Date.parse(time) > Date.parse(other);

/**
 * Shows `stored` for `id`; the names switched off survive only while it is the same proposal of the same file.
 *
 * @param setShown the setter of what is shown
 * @param id the file
 * @param stored the answer read for it
 * @param applied the file's AI tags read with it after a finished batch analysis; null otherwise
 */
export function takeStored(
  setShown: Dispatch<SetStateAction<Shown | null>>,
  id: string,
  stored: Stored,
  applied: readonly AppliedTag[] | null = null,
): void {
  setShown((previous) => {
    const same =
      previous !== null && previous.fileId === id && proposalKey(previous.proposal) === proposalKey(stored.proposal);
    return { fileId: id, proposal: stored.proposal, job: stored.job, off: same ? previous.off : NO_OFF, applied };
  });
}

/**
 * What is shown with the tag `name` switched on or off.
 *
 * @param current what is shown; null for nothing
 * @param name the tag
 * @returns the new value, or `current` when nothing is shown
 */
export function toggledOff(current: Shown | null, name: string): Shown | null {
  if (current === null) return current;
  const off = new Set(current.off);
  if (off.has(name)) off.delete(name);
  else off.add(name);
  return { ...current, off };
}

/**
 * The names the owner left switched on.
 *
 * @param proposal the proposal
 * @param off the names switched off
 * @returns the names to accept
 */
export function namesOn(proposal: ProposalView, off: ReadonlySet<string>): string[] {
  return proposal.tags.filter((tag) => !off.has(tag.name)).map((tag) => tag.name);
}

/**
 * The message of a failed analysis. It counts unless a proposal newer than it is stored (then it is history).
 *
 * @param job the newest job; null for none
 * @param proposal the stored proposal; null for none
 * @returns the message, or null when no failure is to be shown
 */
export function failedMessageOf(job: JobView | null, proposal: ProposalView | null): string | null {
  if (job === null || isActive(job) || job.status !== 'failed') return null;
  if (proposal !== null && !newer(job.createdAt, proposal.createdAt)) return null;
  return job.errorMessage ?? (job.errorCode !== null ? JOB_ERROR_MESSAGES[job.errorCode] : FAILED_FALLBACK);
}
