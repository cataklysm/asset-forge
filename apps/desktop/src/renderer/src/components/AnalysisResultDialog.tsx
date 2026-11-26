import { useEffect, useRef, useState } from 'react';
import {
  ACTIVE_JOB_STATUSES,
  JOB_ERROR_MESSAGES,
  type FileRecord,
  type IpcResponse,
  type JobView,
  type ProposalView,
} from '@assetforge/contracts';
import { ApiError, call, describeError } from '../api';
import { useJobs } from '../jobs-context';
import { jobStatusLabel } from '../labels';
import { useProvider } from '../provider-context';
import { AI_CHIP, ALERT, BUTTON, FOCUS, MUTED } from '../ui';
import { Dialog } from './Dialog';
import { ModelSelect } from './ModelSelect';

interface Props {
  open: boolean;
  file: FileRecord | null;
  onClose(): void;
  /** After an accept or a discard changed the file's tags or proposal. */
  onChanged(): void;
  /** Shows the settings screen; the dialog closes first. Without it no Settings button is offered. */
  onOpenSettings?(): void;
}

/** Shown when an accept would act on a proposal other than the one on screen. */
export const PROPOSAL_CHANGED = 'The proposal has changed. Review it again.';
export const NOT_ANALYSABLE = 'This file cannot be analysed';
export const NO_VISION_MODEL = 'The provider offers no model that can analyse images';
export const MODEL_NOT_VISION = 'This model cannot analyse images';
export const CHOOSE_MODEL = 'Choose a model';
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
  return JSON.stringify([proposal.model, proposal.createdAt, proposal.tags.map((t) => t.name)]);
}

const isActive = (job: JobView | null) =>
  job !== null && (ACTIVE_JOB_STATUSES as readonly string[]).includes(job.status);

const NO_OFF: ReadonlySet<string> = new Set();

/**
 * The single-image analysis: starts a proposal, shows the job while it runs and the stored tag
 * proposal when it is there (tags can be switched off before accepting). It re-reads whenever the
 * jobs context's `changeToken` moves; closing changes nothing.
 */
export function AnalysisResultDialog({ open, file, onClose, onChanged, onOpenSettings }: Props) {
  const { changeToken, refresh } = useJobs();
  const { settings, models, loading: providerLoading } = useProvider();
  const fileId = open && file !== null ? file.id : null;

  const [shown, setShown] = useState<Shown | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  // The owner's pick for this file; until then the tagging default.
  const [chosen, setChosen] = useState<{ fileId: string; model: string | null } | null>(null);
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
      lastFileId.current = null;
      readSeq.current += 1;
      setShown(null);
      setError(null);
      return;
    }
    if (lastFileId.current !== fileId) {
      lastFileId.current = fileId;
      setShown(null);
      setError(null);
      setChosen(null);
    }
    void read(fileId);
    // `read` only uses refs and stable setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId, changeToken]);

  const model = chosen !== null && chosen.fileId === fileId ? chosen.model : (settings?.taggingModel ?? null);

  async function run(action: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  const analyse = () =>
    run(async () => {
      if (file === null || model === null) return;
      const id = file.id;
      try {
        const result = await call('analysis:enqueue', {
          target: { kind: 'files', fileIds: [id] },
          model,
          mode: 'propose',
          force: true,
        });
        refresh();
        await read(id);
        if (result.enqueued === 0 && result.skipped.alreadyQueued === 0) setError(NOT_ANALYSABLE);
      } catch (e) {
        setError(describeError(e));
      }
    });

  const cancel = (jobId: string) =>
    run(async () => {
      if (file === null) return;
      try {
        await call('jobs:cancel', { jobId });
        refresh();
      } catch (e) {
        setError(describeError(e));
      }
      await read(file.id);
    });

  const discard = () =>
    run(async () => {
      if (file === null) return;
      try {
        await call('analysis:discardProposal', { fileId: file.id });
        onChanged();
      } catch (e) {
        setError(describeError(e));
      }
      await read(file.id);
    });

  const accept = () =>
    run(async () => {
      if (file === null || shown === null || shown.proposal === null) return;
      const id = file.id;
      const key = proposalKey(shown.proposal);
      const names = shown.proposal.tags.filter((t) => !shown.off.has(t.name)).map((t) => t.name);
      if (names.length === 0) return;
      try {
        // Never accept names against a proposal other than the one on screen.
        const fresh = await call('analysis:getProposal', { fileId: id });
        if (fileIdRef.current !== id) return;
        if (proposalKey(fresh.proposal) !== key || fresh.proposal?.stale !== false) {
          readSeq.current += 1;
          take(id, fresh);
          setError(PROPOSAL_CHANGED);
          return;
        }
        await call('analysis:acceptProposal', { fileId: id, names });
      } catch (e) {
        if (e instanceof ApiError && (e.code === 'invalid_operation' || e.code === 'not_found')) {
          await read(id);
          setError(PROPOSAL_CHANGED);
        } else {
          setError(describeError(e));
        }
        return;
      }
      onChanged();
      onClose();
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
    onClose();
    onOpenSettings?.();
  }

  // Why Analyse cannot start, as its tooltip; null when it can.
  const configured = settings !== null && settings.baseUrl !== null;
  const list = models !== null && models.ok ? models.models : null;
  const noVisionModel = list !== null && !list.some((m) => m.vision !== false);
  const chosenNotVision = list !== null && list.some((m) => m.name === model && m.vision === false);
  const blocked = !configured
    ? JOB_ERROR_MESSAGES.provider_not_configured
    : noVisionModel
      ? NO_VISION_MODEL
      : model === null
        ? CHOOSE_MODEL
        : chosenNotVision
          ? MODEL_NOT_VISION
          : null;
  const offerSettings = onOpenSettings !== undefined && !providerLoading && (!configured || noVisionModel);

  const current = shown !== null && shown.fileId === fileId ? shown : null;
  const proposal = current?.proposal ?? null;
  const job = current?.job ?? null;
  const running = isActive(job);
  const failed = !running && proposal === null && job !== null && job.status === 'failed';

  function analyseRow(label: string) {
    return (
      <div className="flex flex-col gap-2">
        <ModelSelect
          purpose="tagging"
          value={model}
          onChange={(next) => {
            if (fileId !== null) setChosen({ fileId, model: next });
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
          {offerSettings && (
            <button type="button" className={BUTTON} onClick={openSettings}>
              Settings
            </button>
          )}
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
            {failed && (
              <p role="alert" className={ALERT}>
                {job.errorMessage ?? (job.errorCode !== null ? JOB_ERROR_MESSAGES[job.errorCode] : FAILED_FALLBACK)}
              </p>
            )}
            {analyseRow('Analyse')}
          </>
        )}
      </div>
    </Dialog>
  );
}
