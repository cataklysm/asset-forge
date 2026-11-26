import { createContext, useContext, useState, type ReactNode } from 'react';
import {
  JOB_ERROR_MESSAGES,
  type AnalysisTarget,
  type EnqueueAnalysisResult,
  type FileRecord,
} from '@assetforge/contracts';
import { NONE_ANALYSABLE } from '../analysis';
import {
  ANALYSE_ALL_LABEL,
  ANALYSE_ALL_TITLE,
  ANALYSE_LABEL,
  ANALYSE_TITLE,
  IMAGE_TO_PROMPT_LABEL,
  IMAGE_TO_PROMPT_TITLE,
  REVIEW_TAGS_LABEL,
  REVIEW_TAGS_TITLE,
} from '../labels';
import { useProvider } from '../provider-context';
import { BUTTON } from '../ui';
import { AnalysisResultDialog } from './AnalysisResultDialog';
import { AnalysisStartDialog } from './AnalysisStartDialog';
import { PromptDialog } from './PromptDialog';

/** "Analyse all": disabled with `blocked` as tooltip. Used by the file lists and the asset gallery. */
export function AnalyseAllButton({
  blocked,
  title = ANALYSE_ALL_TITLE,
  onClick,
}: {
  blocked: string | null;
  title?: string;
  onClick(): void;
}) {
  return (
    <button type="button" className={BUTTON} disabled={blocked !== null} title={blocked ?? title} onClick={onClick}>
      {ANALYSE_ALL_LABEL}
    </button>
  );
}

/**
 * The analysis buttons of a selection bar: Analyse for the analysable `files`, and for exactly one
 * analysable image (`single`) Review tags (with a proposal) and Image to prompt.
 */
export function SelectionAnalysisButtons({
  analysis,
  files,
  single,
}: {
  analysis: AnalysisDialogs;
  files: readonly FileRecord[];
  single: FileRecord | null;
}) {
  const none = files.length === 0;
  return (
    <>
      <button
        type="button"
        className={BUTTON}
        disabled={none || analysis.blocked !== null}
        title={none ? NONE_ANALYSABLE : (analysis.blocked ?? ANALYSE_TITLE)}
        onClick={() => analysis.analyseFiles(files)}
      >
        {ANALYSE_LABEL}
      </button>
      {single?.hasProposal === true && (
        <button type="button" className={BUTTON} title={REVIEW_TAGS_TITLE} onClick={() => analysis.review(single)}>
          {REVIEW_TAGS_LABEL}
        </button>
      )}
      {single !== null && (
        <button
          type="button"
          className={BUTTON}
          disabled={analysis.blocked !== null}
          title={analysis.blocked ?? IMAGE_TO_PROMPT_TITLE}
          onClick={() => analysis.prompt(single)}
        >
          {IMAGE_TO_PROMPT_LABEL}
        </button>
      )}
    </>
  );
}

const OpenSettingsContext =createContext<() => void>(() => {});

/** Gives the analysis dialogs below it the way to the settings screen. */
export function OpenSettingsProvider({ onOpenSettings, children }: { onOpenSettings(): void; children: ReactNode }) {
  return <OpenSettingsContext.Provider value={onOpenSettings}>{children}</OpenSettingsContext.Provider>;
}

/** Shows the settings screen; outside an `OpenSettingsProvider` it does nothing. */
export function useOpenSettings(): () => void {
  return useContext(OpenSettingsContext);
}

type Open =
  | { kind: 'start'; target: AnalysisTarget }
  | { kind: 'result'; file: FileRecord }
  | { kind: 'prompt'; file: FileRecord };

interface Options {
  /** The counts of a started batch, for the host's result strip. */
  onStarted(result: EnqueueAnalysisResult): void;
  /** After the result dialog accepted or discarded a proposal: the host reloads its list. */
  onChanged(): void;
  /** Before the settings screen opens (e.g. the host closes its file detail dialog). */
  onLeave?(): void;
}

export interface AnalysisDialogs {
  /**
   * Why no analysis can start (the provider is not configured), as tooltip of the disabled
   * entries; null when it can, or while the settings are still unknown.
   */
  blocked: string | null;
  /** One file opens the single-image result dialog, several the start dialog with a `files` target. */
  analyseFiles(files: readonly FileRecord[]): void;
  /** Opens the start dialog for `target`. */
  start(target: AnalysisTarget): void;
  /** Opens the result dialog of `file` (its proposal). */
  review(file: FileRecord): void;
  /** Opens Image2Prompt for `file`. */
  prompt(file: FileRecord): void;
  /** The dialogs; the host renders them once. */
  dialogs: ReactNode;
}

/**
 * The analysis dialogs of one screen: the start dialog (batches, apply), the result dialog (one
 * image, propose) and Image2Prompt. At most one is open; each chooses its model itself.
 */
export function useAnalysisDialogs({ onStarted, onChanged, onLeave }: Options): AnalysisDialogs {
  const { settings } = useProvider();
  const openSettings = useOpenSettings();
  const [open, setOpen] = useState<Open | null>(null);

  const blocked = settings !== null && settings.baseUrl === null ? JOB_ERROR_MESSAGES.provider_not_configured : null;
  const close = () => setOpen(null);
  const toSettings = () => {
    setOpen(null);
    onLeave?.();
    openSettings();
  };

  function analyseFiles(files: readonly FileRecord[]) {
    const [first] = files;
    if (first === undefined) return;
    if (files.length === 1) setOpen({ kind: 'result', file: first });
    else setOpen({ kind: 'start', target: { kind: 'files', fileIds: files.map((f) => f.id) } });
  }

  const dialogs = (
    <>
      <AnalysisStartDialog
        open={open?.kind === 'start'}
        target={open?.kind === 'start' ? open.target : null}
        onClose={close}
        onStarted={onStarted}
        onOpenSettings={toSettings}
      />
      <AnalysisResultDialog
        open={open?.kind === 'result'}
        file={open?.kind === 'result' ? open.file : null}
        onClose={close}
        onChanged={onChanged}
        onOpenSettings={toSettings}
      />
      <PromptDialog
        open={open?.kind === 'prompt'}
        file={open?.kind === 'prompt' ? open.file : null}
        onClose={close}
        onOpenSettings={toSettings}
      />
    </>
  );

  return {
    blocked,
    analyseFiles,
    start: (target) => setOpen({ kind: 'start', target }),
    review: (file) => setOpen({ kind: 'result', file }),
    prompt: (file) => setOpen({ kind: 'prompt', file }),
    dialogs,
  };
}
