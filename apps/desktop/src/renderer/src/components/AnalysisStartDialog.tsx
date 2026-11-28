import { RotateCw } from 'lucide-react';
import { useRef, useState, type FormEvent, type MutableRefObject } from 'react';
import type { AnalysisPreview, AnalysisTarget, EnqueueAnalysisResult } from '@assetforge/contracts';
import {
  effectivePromptId,
  recoverMissingPrompt,
  useAnalysisPrompts,
  type AnalysisPromptsState,
} from '../analysis-prompts-context';
import { call, describeError } from '../api';
import { useAnalysisPreview } from '../hooks/useAnalysisPreview';
import { useJobs } from '../jobs-context';
import {
  ANALYSIS_START_TITLE,
  CANCEL_LABEL,
  START_COUNTING,
  START_COUNTS,
  START_FORCE_LABEL,
  START_FORCE_TITLE,
  START_LABEL,
  START_NOTHING_TO_DO,
  START_PREVIEW_FAILED,
  START_RETRY_PREVIEW_LABEL,
} from '../labels';
import { useProviderChoice } from '../provider-choice';
import { useProviders, type ProvidersState } from '../provider-context';
import { promptGate, providerGate } from '../provider-gate';
import { ALERT, BUTTON, ICON_BUTTON, LABEL, MUTED } from '../ui';
import { Dialog } from './Dialog';
import { ModelSelect } from './ModelSelect';
import { ProviderSelect } from './ProviderSelect';
import { PromptSelect } from './PromptSelect';
import { SettingsButton } from './SettingsButton';

/** The props of `AnalysisStartDialog`. */
interface Props {
  open: boolean;
  /** What to analyse; nothing is previewed or started without one. */
  target: AnalysisTarget | null;
  onClose(): void;
  /** The counts of a successful start; the dialog closes right after. */
  onStarted(result: EnqueueAnalysisResult): void;
  /** Shows the settings screen; the dialog closes first. */
  onOpenSettings(): void;
  /** Why the settings screen cannot be shown now (Settings is disabled with it); null when it can. */
  settingsBlocked?: string | null;
}

/**
 * How many files a start would enqueue. The preview counts are disjoint: `analysable` is what an
 * enqueue without `force` queues; `force` adds the files already analysed with this model.
 *
 * @param preview the preview counts
 * @param force whether files already analysed are analysed again
 * @returns the number of files
 */
export function wouldEnqueue(preview: AnalysisPreview, force: boolean): number {
  return preview.analysable + (force ? preview.alreadyAnalysed : 0);
}

/**
 * One count as shown: "Analyse again" moves the files already analysed with this model into "To analyse".
 *
 * @param preview the preview counts
 * @param key the count
 * @param force whether files already analysed are analysed again
 * @returns the number shown
 */
function shownCount(preview: AnalysisPreview, key: keyof AnalysisPreview, force: boolean): number {
  if (key === 'analysable') return wouldEnqueue(preview, force);
  if (key === 'alreadyAnalysed' && force) return 0;
  return preview[key];
}

/**
 * Why the counts keep Start disabled.
 *
 * @param previewError the failure of the preview; null for none
 * @param counting whether the counts are not there yet
 * @param nothingToDo whether a start would enqueue nothing
 * @returns the reason, or null when the counts allow a start
 */
function countsBlocked(previewError: string | null, counting: boolean, nothingToDo: boolean): string | null {
  if (previewError !== null) return START_PREVIEW_FAILED;
  if (counting) return START_COUNTING;
  return nothingToDo ? START_NOTHING_TO_DO : null;
}

/** The request of one start. */
interface StartRequest {
  target: AnalysisTarget;
  model: string;
  providerId: string;
  force: boolean;
  promptId: string;
}

/** What a start sets and tells. */
interface StartEffects {
  startingRef: MutableRefObject<boolean>;
  setStarting(starting: boolean): void;
  setError(message: string | null): void;
  /** Drops the owner's prompt pick. */
  dropPromptChoice(): void;
  prompts: AnalysisPromptsState;
  providers: ProvidersState;
  /** Makes the jobs context poll at once. */
  refreshJobs(): void;
  onStarted(result: EnqueueAnalysisResult): void;
  onClose(): void;
}

/**
 * Enqueues the batch in mode `apply`; on success the start is recorded and the dialog closes.
 *
 * @param effects the setters and handlers
 * @param request the request
 * @returns resolves once done; never rejects
 */
async function startAnalysis(effects: StartEffects, request: StartRequest): Promise<void> {
  effects.startingRef.current = true;
  effects.setStarting(true);
  effects.setError(null);
  const { target, model, providerId, force, promptId } = request;
  try {
    const result = await call('analysis:enqueue', { target, model, providerId, mode: 'apply', force, promptId });
    effects.prompts.noteUsed('tagging', request.promptId);
    effects.providers.noteUsed(request.providerId);
    effects.refreshJobs();
    effects.onStarted(result);
    effects.onClose();
  } catch (error) {
    effects.setError(describeError(error));
    recoverMissingPrompt(error, effects.prompts, effects.providers, effects.dropPromptChoice);
  } finally {
    effects.startingRef.current = false;
    effects.setStarting(false);
  }
}

/** The props of `PreviewFailure`. */
interface PreviewFailureProps {
  message: string;
  starting: boolean;
  onRetry(): void;
}

/**
 * The failure of the preview with the action that reads the counts again.
 *
 * @param props the message, whether a start runs and the retry
 */
function PreviewFailure({ message, starting, onRetry }: PreviewFailureProps) {
  return (
    <div className="flex items-start gap-2">
      <p role="alert" className={`min-w-0 flex-1 ${ALERT}`}>
        {message}
      </p>
      <button
        type="button"
        className={ICON_BUTTON}
        title={START_RETRY_PREVIEW_LABEL}
        aria-label={START_RETRY_PREVIEW_LABEL}
        disabled={starting}
        onClick={onRetry}
      >
        <RotateCw size={16} aria-hidden />
      </button>
    </div>
  );
}

/** The props of `PreviewCounts`. */
interface PreviewCountsProps {
  preview: AnalysisPreview | null;
  previewing: boolean;
  force: boolean;
}

/**
 * The preview counts; a dash for each while they are not there.
 *
 * @param props the counts, whether they are read and the force flag
 */
function PreviewCounts({ preview, previewing, force }: PreviewCountsProps) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2" aria-busy={previewing || undefined}>
      {START_COUNTS.map(({ key, label, title }) => (
        <div key={key} className="flex flex-col" title={title}>
          <dt className={LABEL}>{label}</dt>
          <dd className={`text-lg tabular-nums ${preview === null ? MUTED : 'text-text'}`}>
            {preview === null ? '–' : shownCount(preview, key, force)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Starts a batch analysis of a target (several files, an asset, a file or asset filter): a provider
 * (the one used last preselected, changeable), a tagging model (that entry's default preselected), a tagging prompt (the one used last
 * preselected, changeable), the preview counts for that model, "Analyse
 * again" (`force`) and Start, which enqueues in mode `apply`.
 *
 * @param props the target, whether it is open and the handlers
 */
export function AnalysisStartDialog({
  open,
  target,
  onClose,
  onStarted,
  onOpenSettings,
  settingsBlocked = null,
}: Props) {
  const providers = useProviders();
  const prompts = useAnalysisPrompts();
  const jobs = useJobs();
  // Every opening starts from the entry used last and its tagging default.
  const choice = useProviderChoice('tagging', open ? 'open' : null);
  const { providerId, model } = choice;
  // Null while the owner has not chosen: the tagging prompt used last (or the first) is in force.
  const [promptChoice, setPromptChoice] = useState<string | null>(null);
  const [force, setForce] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startingRef = useRef(false);

  // Every opening starts from the stored default with nothing carried over.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setPromptChoice(null);
      setForce(false);
      setError(null);
    }
  }

  // The prompt is not part of the preview: the counts do not depend on it.
  const promptId = effectivePromptId(prompts, 'tagging', promptChoice);
  const { preview, previewing, previewError, retry } = useAnalysisPreview(open, target, model, providerId);

  const nothingToDo = preview !== null && wouldEnqueue(preview, force) === 0;
  // The way to the settings depends on the provider and the model only, never on the counts.
  const { blocked: providerBlocked, offerSettings } = providerGate(providers, providerId, model);
  const blocked =
    providerBlocked ??
    promptGate(prompts, promptId, 'tagging') ??
    countsBlocked(previewError, previewing || preview === null, nothingToDo);
  const canStart = blocked === null && !starting && target !== null;

  /**
   * Starts the batch unless a start is in flight or cannot start.
   *
   * @param event the form submit
   */
  function start(event?: FormEvent) {
    event?.preventDefault();
    if (
      startingRef.current ||
      !canStart ||
      target === null ||
      providerId === null ||
      model === null ||
      promptId === null
    )
      return;
    const effects: StartEffects = {
      startingRef,
      setStarting,
      setError,
      dropPromptChoice: () => setPromptChoice(null),
      prompts,
      providers,
      refreshJobs: jobs.refresh,
      onStarted,
      onClose,
    };
    void startAnalysis(effects, { target, model, providerId, force, promptId });
  }

  /** Cancel, Esc and the backdrop; ignored while a start is in flight, which closes by itself. */
  function close() {
    if (startingRef.current) return;
    onClose();
  }

  /** Ignored while a start is in flight: the dialog closes by itself and the strip shows the result. */
  function openSettings() {
    if (startingRef.current || settingsBlocked !== null) return;
    onClose();
    onOpenSettings();
  }

  return (
    <Dialog open={open} title={ANALYSIS_START_TITLE} onClose={close}>
      <form className="flex flex-col gap-4" onSubmit={(event) => start(event)}>
        {error !== null && (
          <p role="alert" className={ALERT}>
            {error}
          </p>
        )}
        {previewError !== null && <PreviewFailure message={previewError} starting={starting} onRetry={retry} />}
        <ProviderSelect value={providerId} onChange={choice.setProvider} disabled={starting} />
        <ModelSelect
          providerId={providerId}
          purpose="tagging"
          value={model}
          onChange={choice.setModel}
          disabled={starting || providerId === null}
        />
        <PromptSelect purpose="tagging" value={promptId} onChange={setPromptChoice} disabled={starting} />
        <PreviewCounts preview={preview} previewing={previewing} force={force} />
        <label className="flex items-center gap-2 text-sm" title={START_FORCE_TITLE}>
          <input
            type="checkbox"
            checked={force}
            disabled={starting}
            onChange={(event) => setForce(event.target.checked)}
          />
          {START_FORCE_LABEL}
        </label>
        <div className="flex justify-end gap-2">
          {offerSettings && <SettingsButton blocked={settingsBlocked} onClick={openSettings} />}
          <button type="button" className={BUTTON} disabled={starting} onClick={close}>
            {CANCEL_LABEL}
          </button>
          <button type="submit" className={BUTTON} disabled={!canStart} title={blocked ?? undefined}>
            {START_LABEL}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
