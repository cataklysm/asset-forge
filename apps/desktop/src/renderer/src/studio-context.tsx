import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { JOB_ERROR_MESSAGES, purposeOf, variableKey, type FileRecord, type TagAssignment, type UpscaleScale } from '@assetforge/contracts';
import { call } from './api';
import { FileDetailDialog } from './components/FileDetailDialog';
import { GenerationStudio } from './components/GenerationStudio';
import { useJobs } from './jobs-context';
import { NO_IMAGE_PROVIDER_TITLE } from './labels';
import { useProviders } from './provider-context';

export interface StudioState {
  /** Opens the generation studio on `file`. */
  open(file: FileRecord): void;
  /**
   * Starts an upscale of `file`. It names no entry: the main process runs the image provider used
   * last (else the first). Rejects with the reason it did not start.
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

const EMPTY: StudioState = {
  open: () => {},
  upscale: () => Promise.reject(new Error(NO_IMAGE_PROVIDER_TITLE)),
  openFile: async () => {},
  openPrompt: () => {},
  blocked: null,
  recallVariable: () => undefined,
  rememberVariables: () => {},
};

const StudioContext = createContext<StudioState>(EMPTY);

interface Linked {
  file: FileRecord;
  asset: { id: string; name: string; tags: readonly TagAssignment[] } | null;
}

/**
 * The generation studio of the workspace, mounted once, and the linked file dialog that shows a
 * source or result followed from the studio or from the generation details of a file.
 */
export function StudioProvider({ children, onOpenPrompt }: { children: ReactNode; onOpenPrompt?: (promptId: string) => Promise<boolean> }) {
  const providers = useProviders();
  const { refresh } = useJobs();
  const [studioFile, setStudioFile] = useState<FileRecord | null>(null);
  const [linked, setLinked] = useState<Linked | null>(null);
  // Only the newest link may open; an older answer arriving later is dropped.
  const linkRequest = useRef(0);

  // Which of the two dialogs is on top. A native dialog keeps its place in the top layer while it
  // stays open, so the one requested while the other is on top is mounted anew (a new key), which
  // shows it again above the other.
  const top = useRef<'studio' | 'linked' | null>(null);
  const [studioKey, setStudioKey] = useState(0);
  const [linkedKey, setLinkedKey] = useState(0);
  const raise = useCallback((which: 'studio' | 'linked') => {
    if (top.current !== null && top.current !== which) (which === 'studio' ? setStudioKey : setLinkedKey)((key) => key + 1);
    top.current = which;
  }, []);
  // The one closed was on top; the other one, if still open, is now.
  const lower = (which: 'studio' | 'linked', otherOpen: boolean) => {
    if (top.current === which) top.current = otherOpen ? (which === 'studio' ? 'linked' : 'studio') : null;
  };

  const { list } = providers;
  const blocked = list !== null && !list.providers.some((p) => purposeOf(p.kind) === 'image') ? NO_IMAGE_PROVIDER_TITLE : null;

  const open = useCallback(
    (file: FileRecord) => {
      raise('studio');
      setStudioFile(file);
    },
    [raise],
  );

  // `files:measure` answers the record of any file (it measures only an image without dimensions).
  const openFile = useCallback(async (fileId: string) => {
    const request = ++linkRequest.current;
    const file = await call('files:measure', { fileId });
    // An asset that cannot be read does not keep the file from showing; it shows without one.
    const asset = file.assetId === null ? null : await call('assets:get', { id: file.assetId }).catch(() => null);
    if (request !== linkRequest.current) return;
    raise('linked');
    setLinked({ file, asset: asset === null ? null : { id: asset.id, name: asset.name, tags: asset.tags } });
  }, [raise]);

  const openPrompt = useCallback(
    (promptId: string) => {
      // The host asks the leave guard first; a declined navigation keeps both dialogs as they are.
      void (onOpenPrompt?.(promptId) ?? Promise.resolve(true)).then((proceeded) => {
        if (!proceeded) return;
        // An openFile still in flight must not show its dialog after the navigation.
        linkRequest.current += 1;
        top.current = null;
        setStudioFile(null);
        setLinked(null);
      });
    },
    [onOpenPrompt],
  );

  // A paid start: while one for a file is in flight, a repeated click for that file sends nothing.
  const starting = useRef(new Set<string>());
  const upscale = useCallback(
    async (file: FileRecord, scale: UpscaleScale) => {
      if (starting.current.has(file.id)) return;
      starting.current.add(file.id);
      try {
        // No entry here: the renderer does not learn which image entry was used last.
        const result = await call('generations:start', { kind: 'upscale', fileId: file.id, scale });
        if (!result.ok) throw new Error(JOB_ERROR_MESSAGES[result.code]);
        refresh();
      } finally {
        starting.current.delete(file.id);
      }
    },
    [refresh],
  );

  // Variable values typed in the studio, by `variableKey`; in memory only.
  const variables = useRef(new Map<string, string>());
  const recallVariable = useCallback((name: string) => variables.current.get(variableKey(name)), []);
  const rememberVariables = useCallback((values: Readonly<Record<string, string>>) => {
    for (const [name, value] of Object.entries(values)) {
      if (value.trim() === '') variables.current.delete(variableKey(name));
      else variables.current.set(variableKey(name), value);
    }
  }, []);

  const value = useMemo<StudioState>(
    () => ({ open, upscale, openFile, openPrompt, blocked, recallVariable, rememberVariables }),
    [open, upscale, openFile, openPrompt, blocked, recallVariable, rememberVariables],
  );

  const changeLinked = (fileId: string, change: (file: FileRecord) => FileRecord) =>
    setLinked((current) => (current !== null && current.file.id === fileId ? { ...current, file: change(current.file) } : current));

  return (
    <StudioContext.Provider value={value}>
      {children}
      {studioFile !== null && (
        <GenerationStudio
          key={`studio-${studioKey}`}
          file={studioFile}
          onClose={() => {
            lower('studio', linked !== null);
            setStudioFile(null);
          }}
          onOpenFile={(fileId) => void openFile(fileId).catch(() => {})}
        />
      )}
      {linked !== null && (
        <FileDetailDialog
          key={`linked-${linkedKey}`}
          file={linked.file}
          asset={linked.asset}
          actions={{ cover: null, onDetails: () => {}, studio: value }}
          roleControl={null}
          onFileChange={(next) => changeLinked(next.id, () => next)}
          onMeasured={(id, size) => changeLinked(id, (file) => ({ ...file, ...size }))}
          list={null}
          onClose={() => {
            linkRequest.current += 1;
            lower('linked', studioFile !== null);
            setLinked(null);
          }}
        />
      )}
    </StudioContext.Provider>
  );
}

/** The studio of the surrounding `StudioProvider`; outside one nothing opens and nothing starts. */
export function useStudio(): StudioState {
  return useContext(StudioContext);
}
