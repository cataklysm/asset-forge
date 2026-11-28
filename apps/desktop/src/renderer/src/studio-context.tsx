import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
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
import { StudioContext, StudioSessionContext, type StudioSession, type StudioState } from './studio-session';

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
 * source or result followed from the studio or from the generation details of a file. Requesting the
 * one below raises the mounted dialog on top again, so neither loses its state.
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
  const { studioRaise, linkedRaise, raise, lower, clear } = useDialogStack();
  const { starting, guardStart } = useStartGuard();
  const { draft, keepDraft, startError, setStartError, forget } = useStudioDrafts();
  const { recallVariable, rememberVariables } = useVariableMemory();

  const { list, noteUsed } = providers;
  const hasImageEntry = list?.providers.some((entry) => purposeOf(entry.kind) === 'image');
  const blocked = list !== null && !hasImageEntry ? NO_IMAGE_PROVIDER_TITLE : null;

  const open = useCallback(
    (file: FileRecord) => {
      raise('studio');
      setStudioFile(file);
    },
    [raise],
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

  const upscaling = useCallback((fileId: string) => starting(fileId, 'upscale'), [starting]);

  const session = useMemo<StudioSession>(
    () => ({ starting, guardStart, draft, keepDraft, startError, setStartError }),
    [starting, guardStart, draft, keepDraft, startError, setStartError],
  );

  const value = useMemo<StudioState>(
    () => ({ open, upscale, upscaling, openFile, openPrompt, blocked, recallVariable, rememberVariables }),
    [open, upscale, upscaling, openFile, openPrompt, blocked, recallVariable, rememberVariables],
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
          <GenerationStudio raise={studioRaise} file={studioFile} onClose={closeStudio} onOpenFile={openFile} />
        )}
        {linked !== null && (
          <FileDetailDialog
            raise={linkedRaise}
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
