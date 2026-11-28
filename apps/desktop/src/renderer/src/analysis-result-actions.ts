import type { FileRecord } from '@assetforge/contracts';
import { ApiError, call, describeError } from './api';
import { namesOn, proposalKey, type Shown } from './analysis-result';
import type { AnalysisPromptsState } from './analysis-prompts-context';
import type { ProposalReader } from './hooks/useResultOpening';
import { NOT_ANALYSABLE, PROPOSAL_CHANGED } from './labels';
import type { ProvidersState } from './provider-context';

/** What every action of the result dialog works with. */
export interface ResultAction {
  /** False once the dialog closed or switched file; checked after every await. */
  live(): boolean;
  reader: ProposalReader;
  setError(message: string | null): void;
  /** Makes the jobs context poll at once. */
  refresh(): void;
}

/** The choice an analysis starts with; any null means it cannot start. */
export interface AnalyseChoice {
  providerId: string | null;
  model: string | null;
  promptId: string | null;
}

/** Where an accepted start is recorded, and the fallback for a prompt deleted meanwhile. */
export interface AnalyseRecords {
  prompts: AnalysisPromptsState;
  providers: ProvidersState;
  /** Drops the owner's prompt pick. */
  dropChosenPrompt(): void;
}

/**
 * Starts a proposal for the file and shows its job.
 *
 * @param action the action context
 * @param file the file; null does nothing
 * @param choice the provider, model and prompt
 * @param records where the start is recorded
 * @returns resolves once done; never rejects
 */
export async function analyseFile(
  action: ResultAction,
  file: FileRecord | null,
  choice: AnalyseChoice,
  records: AnalyseRecords,
): Promise<void> {
  const { providerId, model, promptId } = choice;
  if (file === null || providerId === null || model === null || promptId === null) return;
  const id = file.id;
  try {
    const result = await call('analysis:enqueue', {
      target: { kind: 'files', fileIds: [id] },
      model,
      providerId,
      mode: 'propose',
      force: true,
      promptId,
    });
    // An accepted start records the prompt and the provider, also when the dialog moved on meanwhile.
    records.prompts.noteUsed('tagging', promptId);
    records.providers.noteUsed(providerId);
    action.refresh();
    if (!action.live()) return;
    await action.reader.read(id);
    if (action.live() && result.enqueued === 0 && result.skipped.alreadyQueued === 0) action.setError(NOT_ANALYSABLE);
  } catch (error) {
    // The prompt may have been deleted meanwhile: list again and fall back to one that exists.
    if (error instanceof ApiError && error.code === 'not_found') {
      void records.prompts.reload().catch(() => {});
      if (action.live()) records.dropChosenPrompt();
    }
    if (action.live()) action.setError(describeError(error));
  }
}

/**
 * Cancels the running job, then reads the file again.
 *
 * @param action the action context
 * @param file the file; null does nothing
 * @param jobId the job
 * @returns resolves once done; never rejects
 */
export async function cancelJob(action: ResultAction, file: FileRecord | null, jobId: string): Promise<void> {
  if (file === null) return;
  try {
    await call('jobs:cancel', { jobId });
    action.refresh();
  } catch (error) {
    if (action.live()) action.setError(describeError(error));
  }
  if (action.live()) await action.reader.read(file.id);
}

/**
 * Discards the stored proposal, then reads the file again.
 *
 * @param action the action context
 * @param file the file; null does nothing
 * @param onChanged told that the data changed
 * @returns resolves once done; never rejects
 */
export async function discardProposal(
  action: ResultAction,
  file: FileRecord | null,
  onChanged: () => void,
): Promise<void> {
  if (file === null) return;
  try {
    await call('analysis:discardProposal', { fileId: file.id });
    // The data changed, also when the dialog closed meanwhile.
    onChanged();
  } catch (error) {
    if (action.live()) action.setError(describeError(error));
  }
  if (action.live()) await action.reader.read(file.id);
}

/**
 * Accepts the names switched on, but only against the proposal on screen; the live opening closes.
 *
 * @param action the action context
 * @param file the file; null does nothing
 * @param shown what is shown; without a proposal nothing happens
 * @param onChanged told that the tags changed
 * @param onClose closes the dialog
 * @returns resolves once done; never rejects
 */
export async function acceptProposal(
  action: ResultAction,
  file: FileRecord | null,
  shown: Shown | null,
  onChanged: () => void,
  onClose: () => void,
): Promise<void> {
  if (file === null || shown === null || shown.proposal === null) return;
  const id = file.id;
  const key = proposalKey(shown.proposal);
  const names = namesOn(shown.proposal, shown.off);
  if (names.length === 0) return;
  try {
    // Never accept names against a proposal other than the one on screen.
    const fresh = await call('analysis:getProposal', { fileId: id });
    if (!action.live()) return;
    if (proposalKey(fresh.proposal) !== key || fresh.proposal?.stale !== false) {
      action.reader.show(id, fresh);
      action.setError(PROPOSAL_CHANGED);
      return;
    }
    await call('analysis:acceptProposal', { fileId: id, names });
  } catch (error) {
    if (!action.live()) return;
    if (error instanceof ApiError && (error.code === 'invalid_operation' || error.code === 'not_found')) {
      await action.reader.read(id);
      if (action.live()) action.setError(PROPOSAL_CHANGED);
    } else {
      action.setError(describeError(error));
    }
    return;
  }
  // The tags changed even if the dialog closed meanwhile; only the live opening closes.
  onChanged();
  if (action.live()) onClose();
}
