import { RotateCw } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { AnalysisPreview, AnalysisTarget, EnqueueAnalysisResult } from '@assetforge/contracts';
import { call, describeError } from '../api';
import { useJobs } from '../jobs-context';
import { useProvider } from '../provider-context';
import { ALERT, BUTTON, ICON_BUTTON, LABEL, MUTED } from '../ui';
import { Dialog } from './Dialog';
import { ModelSelect } from './ModelSelect';

interface Props {
  open: boolean;
  /** What to analyse; nothing is previewed or started without one. */
  target: AnalysisTarget | null;
  onClose(): void;
  /** The counts of a successful start; the dialog closes right after. */
  onStarted(result: EnqueueAnalysisResult): void;
  /** Shows the settings screen; the dialog closes first. */
  onOpenSettings(): void;
}

export const ANALYSIS_START_TITLE = 'Analyse';
const PREVIEW_FAILED = 'The files could not be counted';
const RETRY_PREVIEW_LABEL = 'Count again';

const COUNTS: readonly { key: keyof AnalysisPreview; label: string; title: string }[] = [
  { key: 'analysable', label: 'To analyse', title: 'Files that will be analysed with this model' },
  { key: 'alreadyAnalysed', label: 'Already analysed', title: 'Files already analysed with this model; skipped unless analysed again' },
  { key: 'alreadyQueued', label: 'Already queued', title: 'Files with an analysis that is queued or running' },
  { key: 'notAnalysable', label: 'Not analysable', title: 'Files that are not complete images of a supported type' },
];

/**
 * How many files a start would enqueue. The preview counts are disjoint: `analysable` is what an
 * enqueue without `force` queues; `force` adds the files already analysed with this model.
 */
export function wouldEnqueue(preview: AnalysisPreview, force: boolean): number {
  return preview.analysable + (force ? preview.alreadyAnalysed : 0);
}

/**
 * Starts a batch analysis of a target (several files, an asset, a file or asset filter): a tagging
 * model (the stored default preselected, changeable), the preview counts for that model, "Analyse
 * again" (`force`) and Start, which enqueues in mode `apply`.
 */
export function AnalysisStartDialog({ open, target, onClose, onStarted, onOpenSettings }: Props) {
  const provider = useProvider();
  const jobs = useJobs();
  // Null while the owner has not chosen: the stored tagging default is in force.
  const [choice, setChoice] = useState<{ model: string | null } | null>(null);
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
      setChoice(null);
      setForce(false);
      setError(null);
    }
  }

  const { settings, models } = provider;
  const configured = settings !== null && settings.baseUrl !== null;
  const model = choice !== null ? choice.model : (settings?.taggingModel ?? null);
  const selectable = models !== null && models.ok && models.models.some((m) => m.vision !== false);
  const offerSettings = !provider.loading && (!configured || (models !== null && !selectable));

  // The target as a value: a caller may pass an equal target as a new object on every render.
  const targetKey = target === null ? null : JSON.stringify(target);
  const targetRef = useRef(target);
  targetRef.current = target;

  useEffect(() => {
    const current = targetRef.current;
    setPreview(null);
    setPreviewError(null);
    if (!open || current === null || model === null || !configured) {
      setPreviewing(false);
      return;
    }
    let superseded = false;
    setPreviewing(true);
    call('analysis:preview', { target: current, model })
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
  }, [open, targetKey, model, configured, previewRun]);

  const nothingToDo = preview !== null && wouldEnqueue(preview, force) === 0;
  const blocked = !configured
    ? 'No vision provider is configured'
    : model === null
      ? 'Choose a model'
      : previewError !== null
        ? PREVIEW_FAILED
        : previewing || preview === null
          ? 'The files are being counted'
          : nothingToDo
            ? 'Nothing to analyse'
            : null;
  const canStart = blocked === null && !starting && target !== null;

  async function start(event?: FormEvent) {
    event?.preventDefault();
    if (startingRef.current || !canStart || target === null || model === null) return;
    startingRef.current = true;
    setStarting(true);
    setError(null);
    try {
      const result = await call('analysis:enqueue', { target, model, mode: 'apply', force });
      jobs.refresh();
      onStarted(result);
      onClose();
    } catch (e) {
      setError(describeError(e));
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

  function openSettings() {
    close();
    onOpenSettings();
  }

  const shownError = error ?? previewError;

  /** "Analyse again" moves the files already analysed with this model into "To analyse". */
  function shown(p: AnalysisPreview, key: keyof AnalysisPreview): number {
    if (key === 'analysable') return wouldEnqueue(p, force);
    if (key === 'alreadyAnalysed' && force) return 0;
    return p[key];
  }

  return (
    <Dialog open={open} title={ANALYSIS_START_TITLE} onClose={close}>
      <form className="flex flex-col gap-4" onSubmit={(e) => void start(e)}>
        {shownError !== null && (
          <div className="flex items-start gap-2">
            <p role="alert" className={`min-w-0 flex-1 ${ALERT}`}>
              {shownError}
            </p>
            {error === null && previewError !== null && (
              <button
                type="button"
                className={ICON_BUTTON}
                title={RETRY_PREVIEW_LABEL}
                aria-label={RETRY_PREVIEW_LABEL}
                onClick={() => setPreviewRun((n) => n + 1)}
              >
                <RotateCw size={16} aria-hidden />
              </button>
            )}
          </div>
        )}
        <ModelSelect
          purpose="tagging"
          value={model}
          onChange={(next) => setChoice({ model: next })}
          disabled={starting || !configured}
        />
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2" aria-busy={previewing || undefined}>
          {COUNTS.map(({ key, label, title }) => (
            <div key={key} className="flex flex-col" title={title}>
              <dt className={LABEL}>{label}</dt>
              <dd className={`text-lg tabular-nums ${preview === null ? MUTED : 'text-text'}`}>
                {preview === null ? '–' : shown(preview, key)}
              </dd>
            </div>
          ))}
        </dl>
        <label className="flex items-center gap-2 text-sm" title="Also analyse the files already analysed with this model">
          <input
            type="checkbox"
            checked={force}
            disabled={starting}
            onChange={(e) => setForce(e.target.checked)}
          />
          Analyse again
        </label>
        <div className="flex justify-end gap-2">
          {offerSettings && (
            <button type="button" className={BUTTON} onClick={openSettings}>
              Settings
            </button>
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
