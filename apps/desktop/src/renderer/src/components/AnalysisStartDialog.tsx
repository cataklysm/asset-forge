import { RotateCw } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { AnalysisPreview, AnalysisTarget, EnqueueAnalysisResult } from '@assetforge/contracts';
import { defaultPromptId, useAnalysisPrompts } from '../analysis-prompts-context';
import { ApiError, call, describeError } from '../api';
import { useJobs } from '../jobs-context';
import {
  START_COUNTING,
  START_COUNTS,
  START_FORCE_LABEL,
  START_FORCE_TITLE,
  START_NOTHING_TO_DO,
  START_PREVIEW_FAILED,
  START_RETRY_PREVIEW_LABEL,
} from '../labels';
import { useProviderChoice } from '../provider-choice';
import { useProviders } from '../provider-context';
import { promptGate, providerGate } from '../provider-gate';
import { ALERT, BUTTON, ICON_BUTTON, LABEL, MUTED } from '../ui';
import { Dialog } from './Dialog';
import { ModelSelect } from './ModelSelect';
import { ProviderSelect } from './ProviderSelect';
import { PromptSelect } from './PromptSelect';
import { SettingsButton } from './SettingsButton';

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

export const ANALYSIS_START_TITLE = 'Analyse';

/**
 * How many files a start would enqueue. The preview counts are disjoint: `analysable` is what an
 * enqueue without `force` queues; `force` adds the files already analysed with this model.
 */
export function wouldEnqueue(preview: AnalysisPreview, force: boolean): number {
  return preview.analysable + (force ? preview.alreadyAnalysed : 0);
}

/**
 * Starts a batch analysis of a target (several files, an asset, a file or asset filter): a provider
 * (the one used last preselected, changeable), a tagging model (that entry's default preselected), a tagging prompt (the one used last
 * preselected, changeable), the preview counts for that model, "Analyse
 * again" (`force`) and Start, which enqueues in mode `apply`.
 */
export function AnalysisStartDialog({ open, target, onClose, onStarted, onOpenSettings, settingsBlocked = null }: Props) {
  const providers = useProviders();
  const prompts = useAnalysisPrompts();
  const jobs = useJobs();
  // Every opening starts from the entry used last and its tagging default.
  const choice = useProviderChoice('tagging', open ? 'open' : null);
  const { providerId, model } = choice;
  // Null while the owner has not chosen: the tagging prompt used last (or the first) is in force.
  const [promptChoice, setPromptChoice] = useState<string | null>(null);
  const [force, setForce] = useState(false);
  const [preview, setPreview] = useState<AnalysisPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Rises with every retry of a failed preview, so the preview effect runs again.
  const [previewRun, setPreviewRun] = useState(0);
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
  const promptId = promptChoice ?? defaultPromptId(prompts, 'tagging');

  // The target as a value: a caller may pass an equal target as a new object on every render.
  const targetKey = target === null ? null : JSON.stringify(target);
  const targetRef = useRef(target);
  targetRef.current = target;

  useEffect(() => {
    const current = targetRef.current;
    setPreview(null);
    setPreviewError(null);
    if (!open || current === null || model === null || providerId === null) {
      setPreviewing(false);
      return;
    }
    let superseded = false;
    setPreviewing(true);
    call('analysis:preview', { target: current, model, providerId })
      .then(
        (next) => {
          if (!superseded) setPreview(next);
        },
        (e: unknown) => {
          if (!superseded) setPreviewError(describeError(e));
        },
      )
      .finally(() => {
        if (!superseded) setPreviewing(false);
      });
    return () => {
      superseded = true;
    };
  }, [open, targetKey, model, providerId, previewRun]);

  const nothingToDo = preview !== null && wouldEnqueue(preview, force) === 0;
  // The way to the settings depends on the provider and the model only, never on the counts.
  const { blocked: providerBlocked, offerSettings } = providerGate(providers, providerId, model);
  const blocked =
    providerBlocked ??
    promptGate(prompts, promptId) ??
    (previewError !== null
      ? START_PREVIEW_FAILED
      : previewing || preview === null
        ? START_COUNTING
        : nothingToDo
          ? START_NOTHING_TO_DO
          : null);
  const canStart = blocked === null && !starting && target !== null;

  async function start(event?: FormEvent) {
    event?.preventDefault();
    if (startingRef.current || !canStart || target === null || providerId === null || model === null || promptId === null)
      return;
    startingRef.current = true;
    setStarting(true);
    setError(null);
    try {
      const result = await call('analysis:enqueue', { target, model, providerId, mode: 'apply', force, promptId });
      prompts.noteUsed('tagging', promptId);
      providers.noteUsed(providerId);
      jobs.refresh();
      onStarted(result);
      onClose();
    } catch (e) {
      setError(describeError(e));
      // The prompt may have been deleted meanwhile: list again and fall back to one that exists.
      if (e instanceof ApiError && e.code === 'not_found') {
        setPromptChoice(null);
        void prompts.reload().catch(() => {});
      }
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
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

  /** "Analyse again" moves the files already analysed with this model into "To analyse". */
  function shown(p: AnalysisPreview, key: keyof AnalysisPreview): number {
    if (key === 'analysable') return wouldEnqueue(p, force);
    if (key === 'alreadyAnalysed' && force) return 0;
    return p[key];
  }

  return (
    <Dialog open={open} title={ANALYSIS_START_TITLE} onClose={close}>
      <form className="flex flex-col gap-4" onSubmit={(e) => void start(e)}>
        {error !== null && (
          <p role="alert" className={ALERT}>
            {error}
          </p>
        )}
        {previewError !== null && (
          <div className="flex items-start gap-2">
            <p role="alert" className={`min-w-0 flex-1 ${ALERT}`}>
              {previewError}
            </p>
            <button
              type="button"
              className={ICON_BUTTON}
              title={START_RETRY_PREVIEW_LABEL}
              aria-label={START_RETRY_PREVIEW_LABEL}
              disabled={starting}
              onClick={() => setPreviewRun((n) => n + 1)}
            >
              <RotateCw size={16} aria-hidden />
            </button>
          </div>
        )}
        <ProviderSelect value={providerId} onChange={choice.setProvider} disabled={starting} />
        <ModelSelect
          providerId={providerId}
          purpose="tagging"
          value={model}
          onChange={choice.setModel}
          disabled={starting || providerId === null}
        />
        <PromptSelect purpose="tagging" value={promptId} onChange={setPromptChoice} disabled={starting} />
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2" aria-busy={previewing || undefined}>
          {START_COUNTS.map(({ key, label, title }) => (
            <div key={key} className="flex flex-col" title={title}>
              <dt className={LABEL}>{label}</dt>
              <dd className={`text-lg tabular-nums ${preview === null ? MUTED : 'text-text'}`}>
                {preview === null ? '–' : shown(preview, key)}
              </dd>
            </div>
          ))}
        </dl>
        <label className="flex items-center gap-2 text-sm" title={START_FORCE_TITLE}>
          <input
            type="checkbox"
            checked={force}
            disabled={starting}
            onChange={(e) => setForce(e.target.checked)}
          />
          {START_FORCE_LABEL}
        </label>
        <div className="flex justify-end gap-2">
          {offerSettings && (
            <SettingsButton blocked={settingsBlocked} onClick={openSettings} />
          )}
          <button type="button" className={BUTTON} disabled={starting} onClick={close}>
            Cancel
          </button>
          <button type="submit" className={BUTTON} disabled={!canStart} title={blocked ?? undefined}>
            Start
          </button>
        </div>
      </form>
    </Dialog>
  );
}
