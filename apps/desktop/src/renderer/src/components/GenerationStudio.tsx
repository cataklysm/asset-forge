import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { X } from 'lucide-react';
import {
  GENERATION_PROMPT_MAX,
  JOB_ERROR_MESSAGES,
  type FileRecord,
  type Generation,
  type ImageModel,
  type UpscaleScale,
} from '@assetforge/contracts';
import { ApiError, call, describeError } from '../api';
import { useJobs } from '../jobs-context';
import {
  CLOSE_LABEL,
  NO_IMAGE_PROVIDER_TITLE,
  PROMPT_LENGTH_TITLE,
  PROMPT_TOO_LONG_TITLE,
  SOURCE_IMAGE_LABEL,
  STUDIO_TITLE,
} from '../labels';
import { formatLabel } from '../media-url';
import { useImageProviderChoice } from '../provider-choice';
import { useProviders } from '../provider-context';
import { imageProviderGate } from '../provider-gate';
import { constrain, formFromGeneration, readSafeMode, tileState, writeSafeMode, type StudioForm as Form } from '../studio-state';
import { ALERT, BORDER, ICON_BUTTON, MUTED, SECTION_TITLE } from '../ui';
import { CoverImage } from './CoverImage';
import { Dialog } from './Dialog';
import { StudioForm } from './StudioForm';
import { StudioResults } from './StudioResults';

export interface GenerationStudioProps {
  /** The source image. */
  file: FileRecord;
  onClose(): void;
  /** Opens a result (or the source) in the file detail dialog. */
  onOpenFile(fileId: string): void;
}

/** The form fields the studio holds itself; provider and model come from the provider choice. */
type Fields = Pick<Form, 'prompt' | 'aspectRatio' | 'resolution' | 'safeMode'>;

/** A message of a failed call: fixed main-process messages as sent, anything else described. */
function messageOf(error: unknown): string {
  return error instanceof ApiError && error.code !== 'internal_error' ? error.message : describeError(error);
}

const newestFirst = (a: Generation, b: Generation) =>
  a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1;

/**
 * The generation studio: edits and upscales of one image, in three columns (source, form, results).
 * The results of the file come from `generations:forFile` and are read again whenever the jobs
 * context's `changeToken` moves; a start keeps the form as it is.
 */
export function GenerationStudio({ file, onClose, onOpenFile }: GenerationStudioProps): JSX.Element | null {
  const providers = useProviders();
  const { changeToken, refresh } = useJobs();
  const choice = useImageProviderChoice(file.id);
  const { providerId, model } = choice;

  const [fields, setFields] = useState<Fields>(() => ({ prompt: '', aspectRatio: null, resolution: null, safeMode: readSafeMode() }));
  // "Use settings" on another entry: its model is chosen once the entry is selected.
  const [pendingModel, setPendingModel] = useState<{ providerId: string; model: string | null } | null>(null);
  if (pendingModel !== null && providerId === pendingModel.providerId) {
    setPendingModel(null);
    if (model !== pendingModel.model) choice.setModel(pendingModel.model);
  }

  const [results, setResults] = useState<Generation[] | null>(null);
  const [upscales, setUpscales] = useState<Generation[]>([]);
  const [recent, setRecent] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  // Another source image starts from a fresh form and its own results; safe mode stays as remembered.
  const [shownFileId, setShownFileId] = useState(file.id);
  if (shownFileId !== file.id) {
    setShownFileId(file.id);
    setFields((current) => ({ prompt: '', aspectRatio: null, resolution: null, safeMode: current.safeMode }));
    setPendingModel(null);
    setResults(null);
    setUpscales([]);
    setSelectedId(null);
    setStartError(null);
    setActionError(null);
    setLoadError(null);
  }
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(false);

  const disposed = useRef(false);
  useEffect(() => {
    disposed.current = false;
    return () => {
      disposed.current = true;
    };
  }, []);

  // Only the newest read may set the results.
  const readSeq = useRef(0);
  const loadResults = useCallback(async () => {
    const seq = ++readSeq.current;
    try {
      const answer = await call('generations:forFile', { fileId: file.id });
      if (disposed.current || seq !== readSeq.current) return;
      setResults([...answer.results].sort(newestFirst));
      setLoadError(null);
    } catch (e) {
      if (!disposed.current && seq === readSeq.current) setLoadError(messageOf(e));
    }
  }, [file.id]);

  const selected = results?.find((g) => g.id === selectedId && tileState(g) === 'ready') ?? null;
  const selectedFileId = selected?.outputs[0]?.fileId ?? null;

  // The upscales of the selected result, one level deep; only the newest read may set them.
  const upscaleSeq = useRef(0);
  const loadUpscales = useCallback(async () => {
    const seq = ++upscaleSeq.current;
    if (selectedFileId === null) {
      setUpscales([]);
      return;
    }
    try {
      const answer = await call('generations:forFile', { fileId: selectedFileId });
      if (disposed.current || seq !== upscaleSeq.current) return;
      setUpscales(answer.results.filter((g) => g.kind === 'upscale').sort(newestFirst));
      setLoadError(null);
    } catch (e) {
      if (!disposed.current && seq === upscaleSeq.current) setLoadError(messageOf(e));
    }
  }, [selectedFileId]);

  const loadRecent = useCallback(async () => {
    try {
      const answer = await call('generations:recentPrompts', {});
      if (!disposed.current) setRecent(answer.prompts);
    } catch {
      // Recent prompts are a convenience; without them the select is left out.
    }
  }, []);

  useEffect(() => {
    void loadResults();
  }, [loadResults, changeToken]);

  useEffect(() => {
    void loadUpscales();
  }, [loadUpscales, changeToken]);

  useEffect(() => {
    void loadRecent();
  }, [loadRecent]);

  const imageModels = providerId === null ? undefined : providers.imageModels[providerId];
  const imageModel: ImageModel | null =
    imageModels !== undefined && imageModels !== 'checking' && imageModels.ok
      ? (imageModels.models.find((m) => m.name === model) ?? null)
      : null;
  const form = constrain({ ...fields, providerId, model }, imageModel);

  const hasImageProvider = providers.list?.providers.some((p) => p.kind === 'venice') ?? false;
  const providerBlocked =
    providers.list !== null && !hasImageProvider ? NO_IMAGE_PROVIDER_TITLE : imageProviderGate(providers, providerId, model).blocked;
  const limit = Math.min(imageModel?.promptCharacterLimit ?? GENERATION_PROMPT_MAX, GENERATION_PROMPT_MAX);
  const promptLength = form.prompt.trim().length;
  const promptBlocked =
    promptLength < 1 || promptLength > GENERATION_PROMPT_MAX ? PROMPT_LENGTH_TITLE : promptLength > limit ? PROMPT_TOO_LONG_TITLE : null;
  const blocked = providerBlocked ?? promptBlocked;
  const upscaleBlocked = providerId === null || !hasImageProvider ? NO_IMAGE_PROVIDER_TITLE : null;

  /** After a start, a retry or a removal: the jobs poll at once and the results are read again. */
  function changed() {
    refresh();
    void loadResults();
    void loadUpscales();
  }

  async function generate() {
    if (blocked !== null || starting || providerId === null || model === null) return;
    setStarting(true);
    setStartError(null);
    try {
      const result = await call('generations:start', {
        kind: 'edit',
        fileId: file.id,
        providerId,
        model,
        prompt: form.prompt,
        ...(form.aspectRatio !== null ? { aspectRatio: form.aspectRatio } : {}),
        ...(form.resolution !== null ? { resolution: form.resolution } : {}),
        safeMode: form.safeMode,
      });
      if (disposed.current) return;
      if (!result.ok) setStartError(JOB_ERROR_MESSAGES[result.code]);
      else {
        changed();
        void loadRecent();
      }
    } catch (e) {
      if (!disposed.current) setStartError(messageOf(e));
    } finally {
      if (!disposed.current) setStarting(false);
    }
  }

  /** Runs one result action; its failure is shown above the results. */
  async function act(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await action();
    } catch (e) {
      if (!disposed.current) setActionError(messageOf(e));
    } finally {
      if (!disposed.current) setBusy(false);
    }
  }

  const upscale = (fileId: string, scale: UpscaleScale) =>
    act(async () => {
      if (providerId === null) return;
      const result = await call('generations:start', { kind: 'upscale', fileId, providerId, scale });
      if (disposed.current) return;
      if (!result.ok) setActionError(JOB_ERROR_MESSAGES[result.code]);
      else changed();
    });

  const retry = (g: Generation) =>
    act(async () => {
      await call('generations:retry', { generationId: g.id });
      if (!disposed.current) changed();
    });

  const remove = (g: Generation) =>
    act(async () => {
      await call('generations:remove', { generationId: g.id });
      if (!disposed.current) changed();
    });

  const trash = (fileId: string) =>
    act(async () => {
      const answer = await call('files:trashMany', { fileIds: [fileId] });
      if (disposed.current) return;
      const error = answer.items.find((item) => item.error !== null)?.error ?? null;
      if (error !== null) setActionError(error.message);
      else if (fileId === selectedFileId) setSelectedId(null);
      changed();
    });

  function applySettings(g: Generation) {
    const next = formFromGeneration(g, form);
    setFields({ prompt: next.prompt, aspectRatio: next.aspectRatio, resolution: next.resolution, safeMode: next.safeMode });
    setStartError(null);
    setPendingModel(null);
    if (next.providerId === providerId) {
      if (next.model !== model) choice.setModel(next.model);
      return;
    }
    // A result of an entry that is gone (or no longer an image entry) keeps the selected entry and model.
    const listed = providers.list?.providers.some((p) => p.id === next.providerId && p.kind === 'venice') ?? false;
    if (next.providerId !== null && listed) {
      choice.setProvider(next.providerId);
      setPendingModel({ providerId: next.providerId, model: next.model });
    }
  }

  function change(patch: Partial<Fields>) {
    if (patch.safeMode !== undefined) writeSafeMode(patch.safeMode);
    setStartError(null);
    setFields((current) => ({ ...current, ...patch }));
  }

  const title = `${STUDIO_TITLE} ${file.originalName}`;
  return (
    <Dialog open title={title} onClose={onClose} size="detail" initialFocusRef={promptRef}>
      <div className="flex h-full flex-col">
        <header className={`flex shrink-0 items-center gap-4 border-b py-3 pl-5 pr-4 ${BORDER}`}>
          <h2 title={title} className={`${SECTION_TITLE} flex min-w-0 flex-1 items-center gap-3`}>
            <span className="shrink-0">{STUDIO_TITLE}</span>
            <span aria-hidden className={`h-5 shrink-0 border-l ${BORDER}`} />
            <span className="truncate font-normal">{file.originalName}</span>
          </h2>
          <button type="button" aria-label={CLOSE_LABEL} title={CLOSE_LABEL} className={ICON_BUTTON} onClick={onClose}>
            <X size={18} aria-hidden />
          </button>
        </header>
        <div className="flex min-h-0 flex-1">
          <section aria-label={SOURCE_IMAGE_LABEL} className={`flex w-80 shrink-0 flex-col gap-3 overflow-y-auto border-r p-5 ${BORDER}`}>
            <CoverImageFrame file={file} />
          </section>
          <div className={`w-96 shrink-0 overflow-y-auto border-r p-5 ${BORDER}`}>
            <StudioForm
              form={form}
              model={imageModel}
              recentPrompts={recent}
              onProvider={(id) => {
                setPendingModel(null);
                setStartError(null);
                choice.setProvider(id);
              }}
              onModel={(next) => {
                setPendingModel(null);
                setStartError(null);
                choice.setModel(next);
              }}
              onChange={change}
              blocked={blocked}
              startError={startError}
              busy={starting}
              onGenerate={() => void generate()}
              promptRef={promptRef}
            />
          </div>
          <section className="min-w-0 flex-1 overflow-y-auto p-5" aria-busy={results === null || busy || undefined}>
            {(actionError ?? loadError) !== null && (
              <p role="alert" className={`mb-4 ${ALERT}`}>
                {actionError ?? loadError}
              </p>
            )}
            <StudioResults
              generations={results ?? []}
              upscales={upscales}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onOpen={onOpenFile}
              onUpscale={(fileId, scale) => void upscale(fileId, scale)}
              upscaleBlocked={upscaleBlocked}
              onUseSettings={applySettings}
              onDelete={(fileId) => void trash(fileId)}
              onRetry={(g) => void retry(g)}
              onRemove={(g) => void remove(g)}
              busy={busy}
            />
          </section>
        </div>
      </div>
    </Dialog>
  );
}

/** The source image large, with its name. */
function CoverImageFrame({ file }: { file: FileRecord }) {
  return (
    <>
      <CoverImage fileId={file.id} size="detail" fallback={formatLabel(file.originalName)} className="aspect-square w-full" />
      <p title={file.originalName} className={`truncate text-sm ${MUTED}`}>
        {file.originalName}
      </p>
    </>
  );
}
