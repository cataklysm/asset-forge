import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import {
  JOB_ERROR_MESSAGES,
  type AnalysisTarget,
  type EnqueueAnalysisResult,
  type FileRecord,
} from '@assetforge/contracts';
import { analysableFiles, NONE_ANALYSABLE, singleAnalysable } from '../analysis';
import {
  ANALYSE_ALL_LABEL,
  ANALYSE_ALL_TITLE,
  ANALYSE_LABEL,
  ANALYSE_SELECTION_TITLE,
  ANALYSE_TITLE,
  IMAGE_TO_PROMPT_LABEL,
  IMAGE_TO_PROMPT_TITLE,
  REVIEW_TAGS_LABEL,
  REVIEW_TAGS_TITLE,
} from '../labels';
import { useProviders } from '../provider-context';
import type { FileSelection } from '../selection';
import { BUTTON } from '../ui';
import { AnalysisResultDialog } from './AnalysisResultDialog';
import { AnalysisStartDialog } from './AnalysisStartDialog';
import { PromptDialog } from './PromptDialog';

/** The props of `AnalyseAllButton`. */
interface AnalyseAllButtonProps {
  /** Why it is disabled; null when it is not. */
  blocked: string | null;
  /** The tooltip while it is enabled. */
  title?: string;
  onClick(): void;
}

/**
 * "Analyse all": disabled with `blocked` as tooltip. Used by the file lists and the asset gallery.
 *
 * @param props the blocked reason, the tooltip and the click handler
 */
export function AnalyseAllButton({ blocked, title = ANALYSE_ALL_TITLE, onClick }: AnalyseAllButtonProps) {
  return (
    <button type="button" className={BUTTON} disabled={blocked !== null} title={blocked ?? title} onClick={onClick}>
      {ANALYSE_ALL_LABEL}
    </button>
  );
}

/**
 * The analysis buttons of a selection bar: Analyse (enabled when the selection holds an analysable
 * image; exactly one selected file opens the single-image dialog, more the start dialog for all of
 * them), and for exactly one analysable image Review tags (with a proposal) and Image to prompt.
 *
 * @param props.analysis the analysis dialogs of the screen
 * @param props.selection the file selection
 */
export function SelectionAnalysisButtons({ analysis, selection }: { analysis: AnalysisDialogs; selection: FileSelection }) {
  const none = analysableFiles(selection).length === 0;
  const single = singleAnalysable(selection);
  const title = selection.selected.size > 1 ? ANALYSE_SELECTION_TITLE : ANALYSE_TITLE;
  return (
    <>
      <button
        type="button"
        className={BUTTON}
        disabled={none || analysis.blocked !== null}
        title={none ? NONE_ANALYSABLE : (analysis.blocked ?? title)}
        onClick={() => analysis.analyseFiles([...selection.selected.values()])}
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

/** The way to the settings screen. */
export interface OpenSettings {
  /** Shows the settings screen. */
  open(): void;
  /** Why the settings screen cannot be shown now (e.g. an import runs); null when it can. */
  blocked: string | null;
}

/** The way to the settings screen of the surrounding provider. */
const OpenSettingsContext = createContext<OpenSettings>({ open: () => {}, blocked: null });

/** The props of `OpenSettingsProvider`. */
interface OpenSettingsProviderProps {
  onOpenSettings(): void;
  /** Why the settings screen cannot be shown now; null when it can. */
  blocked?: string | null;
  children: ReactNode;
}

/**
 * Gives the analysis dialogs below it the way to the settings screen.
 *
 * @param props the open handler, its blocked reason and the tree
 */
export function OpenSettingsProvider({ onOpenSettings, blocked = null, children }: OpenSettingsProviderProps) {
  const value = useMemo(() => ({ open: onOpenSettings, blocked }), [onOpenSettings, blocked]);
  return <OpenSettingsContext.Provider value={value}>{children}</OpenSettingsContext.Provider>;
}

/**
 * The way to the settings screen.
 *
 * @returns the way; outside an `OpenSettingsProvider` it does nothing
 */
export function useOpenSettings(): OpenSettings {
  return useContext(OpenSettingsContext);
}

/** The open analysis dialog and what it shows. */
type Open =
  | { kind: 'start'; target: AnalysisTarget }
  | { kind: 'result'; file: FileRecord }
  | { kind: 'prompt'; file: FileRecord };

/** The options of `useAnalysisDialogs`. */
interface Options {
  /** The counts of a started batch, for the host's result strip. */
  onStarted(result: EnqueueAnalysisResult): void;
  /** After the result dialog accepted or discarded a proposal: the host reloads its list. */
  onChanged(): void;
  /** Before the settings screen opens (e.g. the host closes its file detail dialog). */
  onLeave?(): void;
}

/** The analysis dialogs of one screen and the ways to open them. */
export interface AnalysisDialogs {
  /**
   * Why no analysis can start (no provider entry exists), as tooltip of the disabled entries; null
   * when it can, or while the provider list is still unknown.
   */
  blocked: string | null;
  /**
   * One file opens the single-image result dialog, several the start dialog with a `files` target
   * of all of them (the start dialog counts the ones that cannot be analysed).
   */
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
 *
 * @param options the host's start, change and leave handlers
 * @returns the dialogs and the ways to open them
 */
export function useAnalysisDialogs({ onStarted, onChanged, onLeave }: Options): AnalysisDialogs {
  const { list } = useProviders();
  const settingsRoute = useOpenSettings();
  const [open, setOpen] = useState<Open | null>(null);

  const blocked = list !== null && list.providers.length === 0 ? JOB_ERROR_MESSAGES.provider_not_configured : null;
  const close = () => setOpen(null);
  // While the settings screen cannot be shown, nothing closes (the dialogs disable Settings).
  const toSettings = () => {
    if (settingsRoute.blocked !== null) return;
    setOpen(null);
    onLeave?.();
    settingsRoute.open();
  };

  /**
   * Opens the result dialog for one file, the start dialog for several.
   *
   * @param files the chosen files
   */
  function analyseFiles(files: readonly FileRecord[]) {
    const [first] = files;
    if (first === undefined) return;
    if (files.length === 1) setOpen({ kind: 'result', file: first });
    else setOpen({ kind: 'start', target: { kind: 'files', fileIds: files.map((file) => file.id) } });
  }

  const dialogs = (
    <>
      <AnalysisStartDialog
        open={open?.kind === 'start'}
        target={open?.kind === 'start' ? open.target : null}
        onClose={close}
        onStarted={onStarted}
        onOpenSettings={toSettings}
        settingsBlocked={settingsRoute.blocked}
      />
      <AnalysisResultDialog
        open={open?.kind === 'result'}
        file={open?.kind === 'result' ? open.file : null}
        onClose={close}
        onChanged={onChanged}
        onOpenSettings={toSettings}
        settingsBlocked={settingsRoute.blocked}
      />
      <PromptDialog
        open={open?.kind === 'prompt'}
        file={open?.kind === 'prompt' ? open.file : null}
        onClose={close}
        onOpenSettings={toSettings}
        settingsBlocked={settingsRoute.blocked}
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
