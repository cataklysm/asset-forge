import { useEffect, useRef, useState } from 'react';
import {
  ACTIVE_JOB_STATUSES,
  JOB_ERROR_MESSAGES,
  type FileRecord,
  type IpcResponse,
  type JobView,
  type ProposalView,
} from '@assetforge/contracts';
import { defaultPromptId, useAnalysisPrompts } from '../analysis-prompts-context';
import { ApiError, call, describeError } from '../api';
import { useJobs } from '../jobs-context';
import { jobStatusLabel, PROMPT_SELECT_LABEL } from '../labels';
import { useProviderChoice } from '../provider-choice';
import { useProviders } from '../provider-context';
import { promptGate, providerGate } from '../provider-gate';
import { AI_CHIP, ALERT, BUTTON, FOCUS, MUTED } from '../ui';
import { Dialog } from './Dialog';
import { ModelSelect } from './ModelSelect';
import { ProviderSelect } from './ProviderSelect';
import { PromptSelect } from './PromptSelect';
import { SettingsButton } from './SettingsButton';

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

export { CHOOSE_MODEL, MODEL_NOT_LISTED, MODEL_NOT_VISION, NO_VISION_MODEL } from '../labels';

/** Shown when an accept would act on a proposal other than the one on screen. */
export const PROPOSAL_CHANGED = 'The proposal has changed. Review it again.';
export const NOT_ANALYSABLE = 'This file cannot be analysed';
/** Tooltip of the disabled Accept and of the marker of a stale proposal. */
export const STALE_TITLE = 'The file changed after the analysis';
const FAILED_FALLBACK = JOB_ERROR_MESSAGES.internal_error;

type Stored = IpcResponse<'analysis:getProposal'>;

interface Shown {
  fileId: string;
  proposal: ProposalView | null;
  job: JobView | null;
  /** Names switched off; they belong to exactly this proposal. */
  off: ReadonlySet<string>;
}

/** Identifies one stored proposal: a replaced proposal never shares the key of the one before. */
export function proposalKey(proposal: ProposalView | null): string | null {
  if (proposal === null) return null;
  return JSON.stringify([proposal.model, proposal.promptName, proposal.createdAt, proposal.tags.map((t) => t.name)]);
}

const isActive = (job: JobView | null) =>
  job !== null && (ACTIVE_JOB_STATUSES as readonly string[]).includes(job.status);

const NO_OFF: ReadonlySet<string> = new Set();

/** Whether ISO time `a` is later than `b`. */
const newer = (a: string, b: string) => Date.parse(a) > Date.parse(b);

/**
 * The single-image analysis: starts a proposal, shows the job while it runs and the stored tag
 * proposal when it is there (tags can be switched off before accepting). It re-reads whenever the
 * jobs context's `changeToken` moves; closing changes nothing.
 */
export function AnalysisResultDialog({ open, file, onClose, onChanged, onOpenSettings, settingsBlocked = null }: Props) {
  const { changeToken, refresh } = useJobs();
  const providers = useProviders();
  const prompts = useAnalysisPrompts();
  const fileId = open && file !== null ? file.id : null;
  // Every file shown starts from the entry used last and its tagging default.
  const choice = useProviderChoice('tagging', fileId);
  const { providerId, model } = choice;

  const [shown, setShown] = useState<Shown | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Every open (or switch to another file) is a new opening; work started in one never touches the next.
  const openingRef = useRef(0);
  const [opening, setOpening] = useState(0);
  // The opening whose action is in flight; another opening is not blocked by it.
  const busyRef = useRef<number | null>(null);
  const [busyOpening, setBusyOpening] = useState<number | null>(null);
  const busy = busyOpening !== null && busyOpening === opening;

  // The owner's prompt pick for this file; until then the tagging prompt used last (or the first).
  const [chosenPrompt, setChosenPrompt] = useState<{ fileId: string; id: string } | null>(null);
  const fileIdRef = useRef(fileId);
  fileIdRef.current = fileId;
  // Only the newest read may set what is shown.
  const readSeq = useRef(0);
  const lastFileId = useRef<string | null>(null);

  function take(id: string, stored: Stored) {
    setShown((previous) => {
      const same = previous !== null && previous.fileId === id && proposalKey(previous.proposal) === proposalKey(stored.proposal);
      return { fileId: id, proposal: stored.proposal, job: stored.job, off: same ? previous.off : NO_OFF };
    });
  }

  async function read(id: string): Promise<Stored | null> {
    const seq = ++readSeq.current;
    try {
      const stored = await call('analysis:getProposal', { fileId: id });
      if (seq === readSeq.current && fileIdRef.current === id) take(id, stored);
      return stored;
    } catch (e) {
      if (seq === readSeq.current && fileIdRef.current === id) setError(describeError(e));
      return null;
    }
  }

  // Opening (or another file) starts fresh; a moved change token re-reads what is shown.
  useEffect(() => {
    if (fileId === null) {
      if (lastFileId.current !== null) {
        openingRef.current += 1;
        setOpening(openingRef.current);
      }
      lastFileId.current = null;
      readSeq.current += 1;
      setShown(null);
      setError(null);
      return;
    }
    if (lastFileId.current !== fileId) {
      lastFileId.current = fileId;
      openingRef.current += 1;
      setOpening(openingRef.current);
      setShown(null);
      setError(null);
      setChosenPrompt(null);
    }
    void read(fileId);
    // `read` only uses refs and stable setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId, changeToken]);


  const promptId =
    chosenPrompt !== null && chosenPrompt.fileId === fileId ? chosenPrompt.id : defaultPromptId(prompts, 'tagging');

  /**
   * Runs one action of the current opening; `live()` is false once the dialog closed or switched
   * file, and every state change or callback after an await checks it.
   */
  async function run(action: (live: () => boolean) => Promise<void>) {
    const token = openingRef.current;
    if (busyRef.current === token) return;
    busyRef.current = token;
    setBusyOpening(token);
    setError(null);
    const live = () => openingRef.current === token;
    try {
      await action(live);
    } finally {
      if (busyRef.current === token) {
        busyRef.current = null;
        setBusyOpening(null);
      }
    }
  }

  const analyse = () =>
    run(async (live) => {
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
        prompts.noteUsed('tagging', promptId);
        providers.noteUsed(providerId);
        refresh();
        if (!live()) return;
        await read(id);
        if (live() && result.enqueued === 0 && result.skipped.alreadyQueued === 0) setError(NOT_ANALYSABLE);
      } catch (e) {
        // The prompt may have been deleted meanwhile: list again and fall back to one that exists.
        if (e instanceof ApiError && e.code === 'not_found') {
          void prompts.reload().catch(() => {});
          if (live()) setChosenPrompt(null);
        }
        if (live()) setError(describeError(e));
      }
    });

  const cancel = (jobId: string) =>
    run(async (live) => {
      if (file === null) return;
      try {
        await call('jobs:cancel', { jobId });
        refresh();
      } catch (e) {
        if (live()) setError(describeError(e));
      }
      if (live()) await read(file.id);
    });

  const discard = () =>
    run(async (live) => {
      if (file === null) return;
      try {
        await call('analysis:discardProposal', { fileId: file.id });
        // The data changed, also when the dialog closed meanwhile.
        onChanged();
      } catch (e) {
        if (live()) setError(describeError(e));
      }
      if (live()) await read(file.id);
    });

  const accept = () =>
    run(async (live) => {
      if (file === null || shown === null || shown.proposal === null) return;
      const id = file.id;
      const key = proposalKey(shown.proposal);
      const names = shown.proposal.tags.filter((t) => !shown.off.has(t.name)).map((t) => t.name);
      if (names.length === 0) return;
      try {
        // Never accept names against a proposal other than the one on screen.
        const fresh = await call('analysis:getProposal', { fileId: id });
        if (!live()) return;
        if (proposalKey(fresh.proposal) !== key || fresh.proposal?.stale !== false) {
          readSeq.current += 1;
          take(id, fresh);
          setError(PROPOSAL_CHANGED);
          return;
        }
        await call('analysis:acceptProposal', { fileId: id, names });
      } catch (e) {
        if (!live()) return;
        if (e instanceof ApiError && (e.code === 'invalid_operation' || e.code === 'not_found')) {
          await read(id);
          if (live()) setError(PROPOSAL_CHANGED);
        } else {
          setError(describeError(e));
        }
        return;
      }
      // The tags changed even if the dialog closed meanwhile; only the live opening closes.
      onChanged();
      if (live()) onClose();
    });

  function toggle(name: string) {
    setShown((current) => {
      if (current === null) return current;
      const off = new Set(current.off);
      if (off.has(name)) off.delete(name);
      else off.add(name);
      return { ...current, off };
    });
  }

  function openSettings() {
    if (settingsBlocked !== null) return;
    // Never navigate away while this opening's accept, discard, cancel or analyse is in flight.
    if (busyRef.current === openingRef.current) return;
    onClose();
    onOpenSettings();
  }

  // Why Analyse cannot start, as its tooltip; null when it can.
  const { blocked: providerBlocked, offerSettings } = providerGate(providers, providerId, model);
  const blocked = providerBlocked ?? promptGate(prompts, promptId);

  const current = shown !== null && shown.fileId === fileId ? shown : null;
  const proposal = current?.proposal ?? null;
  const job = current?.job ?? null;
  const running = isActive(job);
  // A failed analysis counts unless a proposal newer than it is stored (then it is history).
  const failedMessage =
    !running && job !== null && job.status === 'failed' && (proposal === null || newer(job.createdAt, proposal.createdAt))
      ? (job.errorMessage ?? (job.errorCode !== null ? JOB_ERROR_MESSAGES[job.errorCode] : FAILED_FALLBACK))
      : null;
  const failedAlert = failedMessage !== null && (
    <p role="alert" className={ALERT}>
      {failedMessage}
    </p>
  );

  function analyseRow(label: string) {
    return (
      <div className="flex flex-col gap-2">
        <ProviderSelect value={providerId} onChange={choice.setProvider} disabled={busy} />
        <ModelSelect
          providerId={providerId}
          purpose="tagging"
          value={model}
          onChange={choice.setModel}
          disabled={busy || providerId === null}
        />
        <PromptSelect
          purpose="tagging"
          value={promptId}
          onChange={(id) => {
            if (fileId !== null) setChosenPrompt({ fileId, id });
          }}
          disabled={busy}
        />
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={BUTTON}
            disabled={blocked !== null || busy}
            title={blocked ?? undefined}
            onClick={() => void analyse()}
          >
            {label}
          </button>
          {offerSettings && <SettingsButton blocked={settingsBlocked} onClick={openSettings} />}
        </div>
      </div>
    );
  }

  const onCount = proposal === null || current === null ? 0 : proposal.tags.filter((t) => !current.off.has(t.name)).length;

  return (
    <Dialog open={open && file !== null} title={file?.originalName ?? ''} onClose={onClose}>
      <div className="flex flex-col gap-4" aria-busy={current === null || busy || undefined}>
        {error !== null && (
          <p role="alert" className={ALERT}>
            {error}
          </p>
        )}
        {current === null ? null : running && job !== null ? (
          <div className="flex items-center gap-3">
            <p role="status" className="flex-1 text-text">
              {jobStatusLabel(job.status)}
            </p>
            <button type="button" className={BUTTON} disabled={busy} onClick={() => void cancel(job.id)}>
              Cancel
            </button>
          </div>
        ) : proposal !== null ? (
          <>
            {failedAlert}
            <div className="flex flex-wrap gap-2" role="group" aria-label="Proposed tags">
              {proposal.tags.map((tag) => {
                const on = !current.off.has(tag.name);
                return (
                  <label
                    key={tag.name}
                    title="AI tag"
                    className={`${AI_CHIP} max-w-full cursor-pointer has-disabled:cursor-default ${on ? '' : 'line-through opacity-50'}`}
                  >
                    <input
                      type="checkbox"
                      className={`accent-ai ${FOCUS}`}
                      checked={on}
                      disabled={proposal.stale || busy}
                      onChange={() => toggle(tag.name)}
                    />
                    <span className="truncate">{tag.displayName}</span>
                  </label>
                );
              })}
            </div>
            <div className="flex items-center gap-3 text-sm">
              <span className={`${MUTED} truncate`} title="Model">
                {proposal.model}
              </span>
              {proposal.promptName !== null && (
                <span className={`${MUTED} truncate`} title={PROMPT_SELECT_LABEL}>
                  {proposal.promptName}
                </span>
              )}
              {proposal.stale && (
                <span className="text-warning" title={STALE_TITLE}>
                  Out of date
                </span>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={BUTTON}
                disabled={proposal.stale || onCount === 0 || busy}
                title={proposal.stale ? STALE_TITLE : undefined}
                onClick={() => void accept()}
              >
                Accept
              </button>
              <button type="button" className={BUTTON} disabled={busy} onClick={() => void discard()}>
                Discard
              </button>
            </div>
            {analyseRow('Analyse again')}
          </>
        ) : (
          <>
            {failedAlert}
            {analyseRow('Analyse')}
          </>
        )}
      </div>
    </Dialog>
  );
}
