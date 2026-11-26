import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { JOB_ERROR_MESSAGES, type FileRecord, type TagAssignment, type UpscaleScale } from '@assetforge/contracts';
import { call } from './api';
import { FileDetailDialog } from './components/FileDetailDialog';
import { GenerationStudio } from './components/GenerationStudio';
import { useJobs } from './jobs-context';
import { NO_IMAGE_PROVIDER_TITLE } from './labels';
import { defaultProviderId, useProviders } from './provider-context';

export interface StudioState {
  /** Opens the generation studio on `file`. */
  open(file: FileRecord): void;
  /** Starts an upscale of `file` on the image provider used last (else the first); rejects with the reason it did not start. */
  upscale(file: FileRecord, scale: UpscaleScale): Promise<void>;
  /**
   * Shows the file with id `fileId` in the linked file dialog, which stacks over the dialog the link
   * was followed in; while it is open it moves on to that file. Rejects when the file cannot be read.
   */
  openFile(fileId: string): Promise<void>;
  /** Why no generation can start (no image provider entry), as tooltip of the disabled entries; null while the list is unknown. */
  blocked: string | null;
}

const EMPTY: StudioState = {
  open: () => {},
  upscale: () => Promise.reject(new Error(NO_IMAGE_PROVIDER_TITLE)),
  openFile: async () => {},
  blocked: null,
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
export function StudioProvider({ children }: { children: ReactNode }) {
  const providers = useProviders();
  const { refresh } = useJobs();
  const [studioFile, setStudioFile] = useState<FileRecord | null>(null);
  const [linked, setLinked] = useState<Linked | null>(null);
  const providersRef = useRef(providers);
  providersRef.current = providers;
  // Only the newest link may open; an older answer arriving later is dropped.
  const linkRequest = useRef(0);

  const { list } = providers;
  const blocked = list !== null && !list.providers.some((p) => p.kind === 'venice') ? NO_IMAGE_PROVIDER_TITLE : null;

  const open = useCallback((file: FileRecord) => setStudioFile(file), []);

  // `files:measure` answers the record of any file (it measures only an image without dimensions).
  const openFile = useCallback(async (fileId: string) => {
    const request = ++linkRequest.current;
    const file = await call('files:measure', { fileId });
    const asset = file.assetId === null ? null : await call('assets:get', { id: file.assetId });
    if (request !== linkRequest.current) return;
    setLinked({ file, asset: asset === null ? null : { id: asset.id, name: asset.name, tags: asset.tags } });
  }, []);

  const upscale = useCallback(
    async (file: FileRecord, scale: UpscaleScale) => {
      const providerId = defaultProviderId(providersRef.current, 'venice');
      const result = await call(
        'generations:start',
        providerId === null ? { kind: 'upscale', fileId: file.id, scale } : { kind: 'upscale', fileId: file.id, providerId, scale },
      );
      if (!result.ok) throw new Error(JOB_ERROR_MESSAGES[result.code]);
      refresh();
    },
    [refresh],
  );

  const value = useMemo<StudioState>(() => ({ open, upscale, openFile, blocked }), [open, upscale, openFile, blocked]);

  const changeLinked = (fileId: string, change: (file: FileRecord) => FileRecord) =>
    setLinked((current) => (current !== null && current.file.id === fileId ? { ...current, file: change(current.file) } : current));

  return (
    <StudioContext.Provider value={value}>
      {children}
      {studioFile !== null && (
        <GenerationStudio
          file={studioFile}
          onClose={() => setStudioFile(null)}
          onOpenFile={(fileId) => void openFile(fileId).catch(() => {})}
        />
      )}
      {linked !== null && (
        <FileDetailDialog
          file={linked.file}
          asset={linked.asset}
          actions={{ cover: null, onDetails: () => {}, studio: value }}
          roleControl={null}
          onFileChange={(next) => changeLinked(next.id, () => next)}
          onMeasured={(id, size) => changeLinked(id, (file) => ({ ...file, ...size }))}
          list={null}
          onClose={() => {
            linkRequest.current += 1;
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
