import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  JOB_ERROR_MESSAGES,
  purposeOf,
  variableKey,
  type FileRecord,
  type TagAssignment,
  type UpscaleScale,
} from '@assetforge/contracts';
import { call } from './api';
import { FileDetailDialog } from './components/FileDetailDialog';
import { GenerationStudio } from './components/GenerationStudio';
import { useDialogStack } from './hooks/useDialogStack';
import { useStartGuard } from './hooks/useStartGuard';
import { useStudioDrafts } from './hooks/useStudioDrafts';
import { useJobs } from './jobs-context';
import { NO_IMAGE_PROVIDER_TITLE } from './labels';
import { useProviders } from './provider-context';
import type { StudioForm } from './studio-state';

/** What the studio context offers. */
export interface StudioState {
  /** Opens the generation studio on `file`. */
  open(file: FileRecord): void;
  /**
   * Starts an upscale of `file`. It names no entry: the main process runs the image provider used
   * last (else the first), and an accepted start records it here too. Rejects with the reason a sent start failed. While an upscale of the file
   * is in flight it sends nothing and resolves; the start in flight reports its own outcome.
   */
  upscale(file: FileRecord, scale: UpscaleScale): Promise<void>;
  /**
   * Shows the file with id `fileId` in the linked file dialog, which stacks over the dialog the link
   * was followed in and over the studio; while it is open it moves on to that file. Rejects when the
   * file cannot be read.
   */
  openFile(fileId: string): Promise<void>;
  /**
   * Closes the studio and the linked file dialog and shows the library prompt `promptId` in the
   * Prompts screen (through the host, so the leave guard applies).
   */
  openPrompt(promptId: string): void;
  /** Why no generation can start (no image provider entry), as tooltip of the disabled entries; null while the list is unknown. */
  blocked: string | null;
  /** The value typed last for a library prompt variable of this name (regardless of case), for as long as the provider lives. */
  recallVariable(name: string): string | undefined;
  /** Remembers typed variable values by name; an empty value forgets the name. */
  rememberVariables(values: Readonly<Record<string, string>>): void;
}

/** The studio outside a provider. */
const EMPTY: StudioState = {
  open: () => {},
  upscale: () => Promise.reject(new Error(NO_IMAGE_PROVIDER_TITLE)),
  openFile: async () => {},
  openPrompt: () => {},
  blocked: null,
  recallVariable: () => undefined,
  rememberVariables: () => {},
};

/** The studio of the workspace. */
const StudioContext = createContext<StudioState>(EMPTY);

/** What a generation start is for: an edit or an upscale of one source file. */
export type StartKind = 'edit' | 'upscale';

/**
 * What outlives one instance of the studio dialog while the studio stays open (raising it mounts it
 * anew): the starts in flight and the form of the shown source.
 */
export interface StudioSession {
  /** A start of `kind` for the source `fileId` is in flight. */
  starting(fileId: string, kind: StartKind): boolean;
  /** Runs `start` unless a start of `kind` for `fileId` is in flight; resolves false when it did not run. */
  guardStart(fileId: string, kind: StartKind, start: () => Promise<void>): Promise<boolean>;
  /** The studio form kept for `fileId`; undefined for another file and after the studio was closed. */
  draft(fileId: string): StudioForm | undefined;
  /** Keeps the studio form of `fileId` until the studio closes or shows another file. */
  keepDraft(fileId: string, form: StudioForm): void;
  /** Why the last edit start for the source `fileId` failed; null when it did not or the studio was closed since. */
  startError(fileId: string): string | null;
  /** Sets (or with null clears) the start error of `fileId`; it outlives a raise and goes on close. */
  setStartError(fileId: string, message: string | null): void;
}

// Outside a provider nothing outlives the dialog: every start runs, and no form is kept.
const NO_SESSION: StudioSession = {
  starting: () => false,
  guardStart: async (_fileId, _kind, start) => {
    await start();
    return true;
  },
  draft: () => undefined,
  keepDraft: () => {},
  startError: () => null,
  setStartError: () => {},
};

/** The session of the studio of the workspace. */
const StudioSessionContext = createContext<StudioSession>(NO_SESSION);

/** The file shown in the linked file dialog, with its asset. */
interface Linked {
  file: FileRecord;
  asset: { id: string; name: string; tags: readonly TagAssignment[] } | null;
}

/** The props of `StudioProvider`. */
interface StudioProviderProps {
  children: ReactNode;
  /** Shows a library prompt in the Prompts screen; resolves false when the navigation was declined. */
  onOpenPrompt(promptId: string): Promise<boolean>;
}

/**
 * Reads the file `fileId` and its asset for the linked file dialog. `files:measure` answers the record of
 * any file (it measures only an image without dimensions).
 *
 * @param fileId the file
 * @returns the file and its asset; rejects when the file cannot be read
 */
async function readLinked(fileId: string): Promise<Linked> {
  const file = await call('files:measure', { fileId });
  // An asset that cannot be read does not keep the file from showing; it shows without one.
  const asset = file.assetId === null ? null : await call('assets:get', { id: file.assetId }).catch(() => null);
  return { file, asset: asset === null ? null : { id: asset.id, name: asset.name, tags: asset.tags } };
}

/** What an upscale from outside the studio does after an accepted start. */
interface UpscaleEffects {
  /** Polls the job summary. */
  refresh(): void;
  /** Records the entry as the image entry used last. */
  noteUsed(providerId: string): void;
}

/**
 * Sends an upscale of `file` and polls the jobs after it.
 *
 * @param file the source file
 * @param scale the scale
 * @param effects polls the job summary and records the entry the main process chose
 * @returns resolves once it was sent; rejects with the reason a sent start failed
 */
async function startUpscale(file: FileRecord, scale: UpscaleScale, effects: UpscaleEffects): Promise<void> {
  // No entry here: the main process resolves the image entry used last, and the answer names it.
  const result = await call('generations:start', { kind: 'upscale', fileId: file.id, scale });
  if (!result.ok) throw new Error(JOB_ERROR_MESSAGES[result.code]);
  effects.refresh();
  effects.noteUsed(result.generation.providerId);
}

/**
 * Variable values typed in the studio, by `variableKey`; in memory only.
 *
 * @returns the recall and remember functions
 */
function useVariableMemory(): Pick<StudioState, 'recallVariable' | 'rememberVariables'> {
  const variables = useRef(new Map<string, string>());
  const recallVariable = useCallback((name: string) => variables.current.get(variableKey(name)), []);
  const rememberVariables = useCallback((values: Readonly<Record<string, string>>) => {
    for (const [name, value] of Object.entries(values)) {
      if (value.trim() === '') variables.current.delete(variableKey(name));
      else variables.current.set(variableKey(name), value);
    }
  }, []);
  return { recallVariable, rememberVariables };
}

/**
 * The generation studio of the workspace, mounted once, and the linked file dialog that shows a
 * source or result followed from the studio or from the generation details of a file.
 *
 * @param props the tree that uses the studio and the navigation to a library prompt
 */
export function StudioProvider({ children, onOpenPrompt }: StudioProviderProps) {
  const providers = useProviders();
  const { refresh } = useJobs();
  const [studioFile, setStudioFile] = useState<FileRecord | null>(null);
  const [linked, setLinked] = useState<Linked | null>(null);
  // Only the newest link may open; an older answer arriving later is dropped.
  const linkRequest = useRef(0);
  const { studioKey, linkedKey, raise, lower, clear } = useDialogStack();
  const { starting, guardStart } = useStartGuard();
  const { draft, keepDraft, startError, setStartError, opened, forget } = useStudioDrafts();
  const { recallVariable, rememberVariables } = useVariableMemory();

  const { list, noteUsed } = providers;
  const hasImageEntry = list?.providers.some((entry) => purposeOf(entry.kind) === 'image');
  const blocked = list !== null && !hasImageEntry ? NO_IMAGE_PROVIDER_TITLE : null;

  const open = useCallback(
    (file: FileRecord) => {
      raise('studio');
      opened();
      setStudioFile(file);
    },
    [raise, opened],
  );

  const openFile = useCallback(
    async (fileId: string) => {
      const request = ++linkRequest.current;
      const next = await readLinked(fileId);
      if (request !== linkRequest.current) return;
      raise('linked');
      setLinked(next);
    },
    [raise],
  );

  const openPrompt = useCallback(
    (promptId: string) => {
      // The host asks the leave guard first; a declined (or failed) navigation keeps both dialogs as they are.
      void onOpenPrompt(promptId).then(
        (proceeded) => {
          if (!proceeded) return;
          // An openFile still in flight must not show its dialog after the navigation.
          linkRequest.current += 1;
          clear();
          forget();
          setStudioFile(null);
          setLinked(null);
        },
        () => {},
      );
    },
    [onOpenPrompt, clear, forget],
  );

  const upscale = useCallback(
    async (file: FileRecord, scale: UpscaleScale) => {
      await guardStart(file.id, 'upscale', () => startUpscale(file, scale, { refresh, noteUsed }));
    },
    [guardStart, refresh, noteUsed],
  );

  const session = useMemo<StudioSession>(
    () => ({ starting, guardStart, draft, keepDraft, startError, setStartError }),
    [starting, guardStart, draft, keepDraft, startError, setStartError],
  );

  const value = useMemo<StudioState>(
    () => ({ open, upscale, openFile, openPrompt, blocked, recallVariable, rememberVariables }),
    [open, upscale, openFile, openPrompt, blocked, recallVariable, rememberVariables],
  );

  const changeLinked = (fileId: string, change: (file: FileRecord) => FileRecord) =>
    setLinked((current) =>
      current !== null && current.file.id === fileId ? { ...current, file: change(current.file) } : current,
    );

  const closeStudio = () => {
    lower('studio', linked !== null);
    forget();
    setStudioFile(null);
  };

  const closeLinked = () => {
    linkRequest.current += 1;
    lower('linked', studioFile !== null);
    setLinked(null);
  };

  return (
    <StudioContext.Provider value={value}>
      <StudioSessionContext.Provider value={session}>
        {children}
        {studioFile !== null && (
          <GenerationStudio key={`studio-${studioKey}`} file={studioFile} onClose={closeStudio} onOpenFile={openFile} />
        )}
        {linked !== null && (
          <FileDetailDialog
            key={`linked-${linkedKey}`}
            file={linked.file}
            asset={linked.asset}
            actions={{ cover: null, studio: value }}
            roleControl={null}
            onFileChange={(next) => changeLinked(next.id, () => next)}
            onMeasured={(id, size) => changeLinked(id, (file) => ({ ...file, ...size }))}
            list={null}
            onClose={closeLinked}
          />
        )}
      </StudioSessionContext.Provider>
    </StudioContext.Provider>
  );
}

/**
 * The starts in flight and the kept form of the surrounding `StudioProvider`.
 *
 * @returns the session; outside a provider nothing is kept
 */
export function useStudioSession(): StudioSession {
  return useContext(StudioSessionContext);
}

/**
 * The studio of the surrounding `StudioProvider`.
 *
 * @returns the studio; outside a provider nothing opens and nothing starts
 */
export function useStudio(): StudioState {
  return useContext(StudioContext);
}
