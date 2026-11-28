import type { FileRecord, JobView } from '@assetforge/contracts';
import { effectivePromptId, useAnalysisPrompts } from '../analysis-prompts-context';
import { failedMessageOf, isActive, isBatchJob, namesOn, type Shown } from '../analysis-result';
import { acceptProposal, analyseFile, cancelJob, discardProposal, type ResultAction } from '../analysis-result-actions';
import { useResultOpening } from '../hooks/useResultOpening';
import { useJobs } from '../jobs-context';
import { ANALYSE_LABEL, BATCH_ANALYSIS_LABEL, CANCEL_LABEL, jobStatusLabel, START_FORCE_LABEL } from '../labels';
import { useProviderChoice } from '../provider-choice';
import { useProviders } from '../provider-context';
import { promptGate, providerGate } from '../provider-gate';
import { ALERT, BUTTON } from '../ui';
import {
  AnalyseRow,
  AppliedTags,
  ProposalButtons,
  ProposalFacts,
  ProposedTags,
  type AnalyseRowProps,
} from './AnalysisResultParts';
import { Dialog } from './Dialog';

/** The props of `AnalysisResultDialog`. */
interface Props {
  open: boolean;
  file: FileRecord | null;
  onClose(): void;
  /** After an accept or a discard changed the file's tags or proposal. */
  onChanged(): void;
  /** Shows the settings screen; the dialog closes first. */
  onOpenSettings(): void;
  /** Why the settings screen cannot be shown now (Settings is disabled with it); null when it can. */
  settingsBlocked?: string | null;
}

export {
  CHOOSE_MODEL,
  MODEL_NOT_LISTED,
  MODEL_NOT_VISION,
  NO_VISION_MODEL,
  NOT_ANALYSABLE,
  PROPOSAL_CHANGED,
  STALE_TITLE,
} from '../labels';
export { proposalKey } from '../analysis-result';

/** The props of `ResultBody`. */
interface ResultBodyProps {
  /** What is shown for the file; null while it is read. */
  current: Shown | null;
  busy: boolean;
  /** The selects and the button of the analysis, without its label. */
  analyseRow: AnalyseRowProps;
  onCancel(jobId: string): void;
  onToggle(name: string): void;
  onAccept(): void;
  onDiscard(): void;
}

/** The props of `ActiveJob`. */
interface ActiveJobProps {
  job: JobView;
  busy: boolean;
  onCancel(jobId: string): void;
}

/**
 * The state of an active job: a batch analysis of the file as a fixed state (it is not this dialog's to cancel,
 * and a forced start would skip the file), the dialog's own job with Cancel.
 *
 * @param props the active job, whether an action is in flight and the cancel of the dialog's own job
 * @returns the state line
 */
function ActiveJob({ job, busy, onCancel }: ActiveJobProps) {
  if (isBatchJob(job)) {
    return (
      <p role="status" className="text-text">
        {BATCH_ANALYSIS_LABEL}
      </p>
    );
  }
  return (
    <div className="flex items-center gap-3">
      <p role="status" className="flex-1 text-text">
        {jobStatusLabel(job.status)}
      </p>
      <button type="button" className={BUTTON} disabled={busy} onClick={() => onCancel(job.id)}>
        {CANCEL_LABEL}
      </button>
    </div>
  );
}

/**
 * The active job (`ActiveJob`), else the proposal with its actions and Analyse again, else the tags a finished
 * batch analysis applied with Analyse again, else Analyse; a failed analysis above the proposal and above Analyse.
 *
 * @param props what is shown, the analyse row and the handlers
 */
function ResultBody({ current, busy, analyseRow, onCancel, onToggle, onAccept, onDiscard }: ResultBodyProps) {
  if (current === null) return null;
  const { proposal, job } = current;
  if (isActive(job) && job !== null) return <ActiveJob job={job} busy={busy} onCancel={onCancel} />;
  const failedMessage = failedMessageOf(job, proposal);
  const failedAlert = failedMessage !== null && (
    <p role="alert" className={ALERT}>
      {failedMessage}
    </p>
  );
  if (proposal === null && current.applied !== null) {
    return (
      <>
        <AppliedTags tags={current.applied} model={job?.model ?? null} />
        <AnalyseRow {...analyseRow} label={START_FORCE_LABEL} />
      </>
    );
  }
  if (proposal === null) {
    return (
      <>
        {failedAlert}
        <AnalyseRow {...analyseRow} label={ANALYSE_LABEL} />
      </>
    );
  }
  return (
    <>
      {failedAlert}
      <ProposedTags proposal={proposal} off={current.off} busy={busy} onToggle={onToggle} />
      <ProposalFacts proposal={proposal} />
      <ProposalButtons
        proposal={proposal}
        onCount={namesOn(proposal, current.off).length}
        busy={busy}
        onAccept={onAccept}
        onDiscard={onDiscard}
      />
      <AnalyseRow {...analyseRow} label={START_FORCE_LABEL} />
    </>
  );
}

/**
 * The single-image analysis: starts a proposal, shows the job while it runs and the stored tag
 * proposal when it is there (tags can be switched off before accepting). It re-reads whenever the
 * jobs context's `changeToken` moves; closing changes nothing.
 *
 * @param props the file, whether it is open and the handlers
 */
export function AnalysisResultDialog({
  open,
  file,
  onClose,
  onChanged,
  onOpenSettings,
  settingsBlocked = null,
}: Props) {
  const { changeToken, refresh } = useJobs();
  const providers = useProviders();
  const prompts = useAnalysisPrompts();
  const fileId = open && file !== null ? file.id : null;
  // Every file shown starts from the entry used last and its tagging default.
  const choice = useProviderChoice('tagging', fileId);
  const { providerId, model } = choice;
  const opening = useResultOpening(fileId, changeToken);
  const { shown, error, busy, chosenPrompt, run } = opening;

  const chosenHere = chosenPrompt !== null && chosenPrompt.fileId === fileId ? chosenPrompt.id : null;
  const promptId = effectivePromptId(prompts, 'tagging', chosenHere);

  /**
   * The context of one action of the current opening.
   *
   * @param live whether the opening is still the current one
   * @returns the context
   */
  const actionOf = (live: () => boolean): ResultAction => ({
    live,
    reader: opening.reader,
    setError: opening.setError,
    refresh,
  });
  const records = { prompts, providers, dropChosenPrompt: () => opening.setChosenPrompt(null) };
  const analyse = () => run((live) => analyseFile(actionOf(live), file, { providerId, model, promptId }, records));

  function openSettings() {
    if (settingsBlocked !== null) return;
    // Never navigate away while this opening's accept, discard, cancel or analyse is in flight.
    if (opening.actionInFlight()) return;
    onClose();
    onOpenSettings();
  }

  // Why Analyse cannot start, as its tooltip; null when it can.
  const { blocked: providerBlocked, offerSettings } = providerGate(providers, providerId, model);
  const blocked = providerBlocked ?? promptGate(prompts, promptId, 'tagging');
  const current = shown !== null && shown.fileId === fileId ? shown : null;

  const analyseRow: AnalyseRowProps = {
    providerId,
    model,
    promptId,
    busy,
    blocked,
    offerSettings,
    settingsBlocked,
    onProvider: choice.setProvider,
    onModel: choice.setModel,
    onPrompt: (id) => {
      if (fileId !== null) opening.setChosenPrompt({ fileId, id });
    },
    onAnalyse: () => void analyse(),
    onOpenSettings: openSettings,
  };

  return (
    <Dialog open={open && file !== null} title={file?.originalName ?? ''} onClose={onClose}>
      <div className="flex flex-col gap-4" aria-busy={current === null || busy || undefined}>
        {error !== null && (
          <p role="alert" className={ALERT}>
            {error}
          </p>
        )}
        <ResultBody
          current={current}
          busy={busy}
          analyseRow={analyseRow}
          onCancel={(jobId) => void run((live) => cancelJob(actionOf(live), file, jobId))}
          onToggle={opening.toggle}
          onAccept={() => void run((live) => acceptProposal(actionOf(live), file, shown, onChanged, onClose))}
          onDiscard={() => void run((live) => discardProposal(actionOf(live), file, onChanged))}
        />
      </div>
    </Dialog>
  );
}
