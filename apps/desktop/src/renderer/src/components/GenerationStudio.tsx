import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { X } from 'lucide-react';
import {
  GENERATION_PROMPT_MAX,
  JOB_ERROR_MESSAGES,
  purposeOf,
  type FileRecord,
  type Generation,
  type ImageModel,
  type PromptDetail,
  type PromptVersion,
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
  VARIABLE_MISSING_TITLE,
} from '../labels';
import { formatLabel } from '../media-url';
import { useImageProviderChoice } from '../provider-choice';
import { useProviders } from '../provider-context';
import { imageProviderGate } from '../provider-gate';
import { useStudio, useStudioSession } from '../studio-context';
import { attach, preview } from '../studio-prompt';
import { constrain, formFromGeneration, readSafeMode, tileState, writeSafeMode, type StudioForm as Form } from '../studio-state';
import { ALERT, BORDER, ICON_BUTTON, MUTED, SECTION_TITLE } from '../ui';
import { CoverImage } from './CoverImage';
import { Dialog } from './Dialog';
import { PromptPicker } from './PromptPicker';
import { SavePromptDialog } from './SavePromptDialog';
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
type Fields = Pick<Form, 'prompt' | 'attached' | 'origin' | 'aspectRatio' | 'resolution' | 'safeMode'>;

const freshFields = (safeMode: boolean): Fields => ({
  prompt: '',
  attached: null,
  origin: null,
  aspectRatio: null,
  resolution: null,
  safeMode,
});

const fieldsOf = (form: Form): Fields => ({
  prompt: form.prompt,
  attached: form.attached,
  origin: form.origin,
  aspectRatio: form.aspectRatio,
  resolution: form.resolution,
  safeMode: form.safeMode,
});

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
  const { recallVariable, rememberVariables } = useStudio();
  const session = useStudioSession();
  const choice = useImageProviderChoice(file.id);
  const { providerId, model } = choice;

  // A studio mounted anew by a raise shows the form it had; a fresh opening starts empty.
  const [restored] = useState(() => session.draft(file.id));
  const [fields, setFields] = useState<Fields>(() => (restored !== undefined ? fieldsOf(restored) : freshFields(readSafeMode())));
  const [picking, setPicking] = useState(false);
  const [saving, setSaving] = useState(false);
  // "Use settings" on another entry: its model is chosen once the entry is selected. A restored form
  // chooses its entry and model the same way.
  const [pendingModel, setPendingModel] = useState<{ providerId: string; model: string | null } | null>(() =>
    restored?.providerId != null ? { providerId: restored.providerId, model: restored.model } : null,
  );
  useEffect(() => {
    if (restored?.providerId != null && restored.providerId !== providerId) choice.setProvider(restored.providerId);
    // Only the first render's entry decides whether the restored one must be selected.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (pendingModel !== null && providerId === pendingModel.providerId) {
    setPendingModel(null);
    if (model !== pendingModel.model) choice.setModel(pendingModel.model);
  }

  const [results, setResults] = useState<Generation[] | null>(null);
  const [upscales, setUpscales] = useState<Generation[]>([]);
  const [recent, setRecent] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Also kept in the session, so that a start failing after a raise shows in the instance mounted anew
  // (outside a provider the session keeps nothing and this instance's own copy shows it).
  const [ownStartError, setOwnStartError] = useState<string | null>(null);
  const startError = session.startError(file.id) ?? ownStartError;
  const setStartError = (message: string | null) => {
    setOwnStartError(message);
    session.setStartError(file.id, message);
  };
  const [actionError, setActionError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  // Another source image starts from a fresh form and its own results; safe mode stays as remembered.
  const [shownFileId, setShownFileId] = useState(file.id);
  if (shownFileId !== file.id) {
    setShownFileId(file.id);
    setFields((current) => freshFields(current.safeMode));
    setPicking(false);
    setSaving(false);
    setPendingModel(null);
    setResults(null);
    setUpscales([]);
    setSelectedId(null);
    setOwnStartError(null);
    setActionError(null);
    setLoadError(null);
  }
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  // A start of this instance, or one sent from an instance before a raise.
  const startBusy = starting || session.starting(file.id, 'edit');
  const upscaleBusy = (fileId: string | null) => fileId !== null && session.starting(fileId, 'upscale');

  // The form as typed (a "Use settings" entry and model still waiting count as chosen).
  const { keepDraft } = session;
  const keptProviderId = pendingModel?.providerId ?? providerId;
  const keptModel = pendingModel !== null ? pendingModel.model : model;
  useEffect(() => {
    if (shownFileId === file.id) keepDraft(file.id, { ...fields, providerId: keptProviderId, model: keptModel });
  }, [keepDraft, shownFileId, file.id, fields, keptProviderId, keptModel]);

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

  // A start sent before a raise ends after this instance read its results: they are read again.
  const sessionStarting = session.starting(file.id, 'edit');
  const wasStarting = useRef(sessionStarting);
  useEffect(() => {
    if (wasStarting.current && !sessionStarting) {
      void loadResults();
      void loadRecent();
    }
    wasStarting.current = sessionStarting;
  }, [sessionStarting, loadResults, loadRecent]);

  const imageModels = providerId === null ? undefined : providers.imageModels[providerId];
  const imageModel: ImageModel | null =
    imageModels !== undefined && imageModels !== 'checking' && imageModels.ok
      ? (imageModels.models.find((m) => m.name === model) ?? null)
      : null;
  const form = constrain({ ...fields, providerId, model }, imageModel);

  const hasImageProvider = providers.list?.providers.some((p) => purposeOf(p.kind) === 'image') ?? false;
  const providerBlocked =
    providers.list !== null && !hasImageProvider ? NO_IMAGE_PROVIDER_TITLE : imageProviderGate(providers, providerId, model).blocked;
  const limit = Math.min(imageModel?.promptCharacterLimit ?? GENERATION_PROMPT_MAX, GENERATION_PROMPT_MAX);
  const shown = form.attached === null ? null : preview(form.attached);
  const promptLength = (shown?.text ?? form.prompt).trim().length;
  const promptBlocked =
    shown?.blocked != null
      ? VARIABLE_MISSING_TITLE
      : promptLength < 1 || promptLength > GENERATION_PROMPT_MAX
        ? PROMPT_LENGTH_TITLE
        : promptLength > limit
          ? PROMPT_TOO_LONG_TITLE
          : null;
  const blocked = providerBlocked ?? promptBlocked;
  const upscaleBlocked = providerId === null || !hasImageProvider ? NO_IMAGE_PROVIDER_TITLE : null;

  /** After a start, a retry or a removal: the jobs poll at once and the results are read again. */
  function changed() {
    refresh();
    void loadResults();
    void loadUpscales();
  }

  async function generate() {
    if (blocked !== null || startBusy || providerId === null || model === null) return;
    setStarting(true);
    setStartError(null);
    try {
      await session.guardStart(file.id, 'edit', async () => {
        const result = await call('generations:start', {
          kind: 'edit',
          fileId: file.id,
          providerId,
          model,
          ...(form.attached !== null
            ? { promptVersionId: form.attached.version.id, variables: form.attached.values }
            : { prompt: form.prompt }),
          ...(form.aspectRatio !== null ? { aspectRatio: form.aspectRatio } : {}),
          ...(form.resolution !== null ? { resolution: form.resolution } : {}),
          safeMode: form.safeMode,
        });
        // A studio mounted anew meanwhile reads its results when the jobs poll and shows the error.
        if (result.ok) refresh();
        else setStartError(JOB_ERROR_MESSAGES[result.code]);
        if (disposed.current) return;
        if (result.ok) {
          changed();
          void loadRecent();
        }
      });
    } catch (e) {
      setStartError(messageOf(e));
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
      await session.guardStart(fileId, 'upscale', async () => {
        const result = await call('generations:start', { kind: 'upscale', fileId, providerId, scale });
        if (result.ok) refresh();
        if (disposed.current) return;
        if (!result.ok) setActionError(JOB_ERROR_MESSAGES[result.code]);
        else changed();
      });
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

  // Only the newest library load may attach a prompt; a free text chosen since then wins.
  const promptSeq = useRef(0);
  useEffect(() => {
    promptSeq.current += 1;
  }, [file.id]);

  /** Loads a library prompt and attaches the version `pickVersion` chooses; resolves false when superseded. */
  async function loadPrompt(
    promptId: string,
    pickVersion: (detail: PromptDetail) => PromptVersion | undefined,
    given: Readonly<Record<string, string>> = {},
  ): Promise<boolean> {
    const seq = ++promptSeq.current;
    const detail = await call('prompts:get', { promptId });
    if (disposed.current || seq !== promptSeq.current) return false;
    const version = pickVersion(detail);
    if (version === undefined) return false;
    setFields((current) => ({ ...current, attached: attach(detail, version, recallVariable, given), origin: null }));
    setStartError(null);
    return true;
  }

  async function pickPrompt(promptId: string) {
    try {
      if (await loadPrompt(promptId, (detail) => detail.currentVersion)) setPicking(false);
    } catch (e) {
      throw new Error(messageOf(e));
    }
  }

  function loadCurrent() {
    const attached = form.attached;
    if (attached === null) return;
    loadPrompt(attached.promptId, (detail) => detail.currentVersion, attached.values).catch((e: unknown) => {
      if (!disposed.current) setStartError(messageOf(e));
    });
  }

  function editText() {
    const attached = form.attached;
    if (attached === null) return;
    promptSeq.current += 1;
    setFields((current) => ({
      ...current,
      prompt: preview(attached).text,
      attached: null,
      origin: { promptId: attached.promptId, title: attached.title },
    }));
    setStartError(null);
  }

  function setVariable(name: string, value: string) {
    rememberVariables({ [name]: value });
    setStartError(null);
    setFields((current) =>
      current.attached === null ? current : { ...current, attached: { ...current.attached, values: { ...current.attached.values, [name]: value } } },
    );
  }

  function chooseRecent(prompt: string) {
    promptSeq.current += 1;
    setStartError(null);
    setFields((current) => ({ ...current, prompt, attached: null, origin: null }));
  }

  function saved(detail: PromptDetail) {
    promptSeq.current += 1;
    setSaving(false);
    setStartError(null);
    setFields((current) => ({ ...current, attached: attach(detail, detail.currentVersion, recallVariable), origin: null }));
  }

  function applySettings(g: Generation) {
    const next = formFromGeneration(g, form);
    setFields({
      prompt: next.prompt,
      attached: next.attached,
      origin: next.origin,
      aspectRatio: next.aspectRatio,
      resolution: next.resolution,
      safeMode: next.safeMode,
    });
    setStartError(null);
    if (g.kind === 'edit') {
      const { promptId, promptVersionId } = g;
      if (promptId !== null && promptVersionId !== null) {
        // A prompt that is gone (or cannot be read) leaves its resolved text as the free prompt.
        loadPrompt(promptId, (detail) => detail.versions.find((v) => v.id === promptVersionId), g.promptVariables ?? {}).catch(
          () => {},
        );
      } else promptSeq.current += 1;
    }
    setPendingModel(null);
    if (next.providerId === providerId) {
      if (next.model !== model) choice.setModel(next.model);
      return;
    }
    // A result of an entry that is gone (or no longer an image entry) keeps the selected entry and model.
    const listed = providers.list?.providers.some((p) => p.id === next.providerId && purposeOf(p.kind) === 'image') ?? false;
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
              onRecent={chooseRecent}
              onLibrary={() => setPicking(true)}
              onVariable={setVariable}
              onEditText={editText}
              onLoadCurrent={loadCurrent}
              onSaveToLibrary={() => setSaving(true)}
              blocked={blocked}
              startError={startError}
              busy={startBusy}
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
              busy={busy || upscaleBusy(selectedFileId)}
            />
          </section>
        </div>
      </div>
      {picking && <PromptPicker onPick={pickPrompt} onClose={() => setPicking(false)} />}
      {saving && <SavePromptDialog prompt={form.prompt} origin={form.origin} onSaved={saved} onClose={() => setSaving(false)} />}
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
