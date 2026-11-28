import { useEffect, type JSX } from 'react';
import { X } from 'lucide-react';
import type { FileRecord, Generation, UpscaleScale } from '@assetforge/contracts';
import { useStudioFields } from '../hooks/useStudioFields';
import { useStudioPrompt } from '../hooks/useStudioPrompt';
import { useStudioReads } from '../hooks/useStudioReads';
import { useStudioStatus } from '../hooks/useStudioStatus';
import { useJobs } from '../jobs-context';
import { CLOSE_LABEL, LINKED_FILE_FAILED, NO_IMAGE_PROVIDER_TITLE, SOURCE_IMAGE_LABEL, STUDIO_TITLE } from '../labels';
import { formatLabel } from '../media-url';
import { useImageProviderChoice } from '../provider-choice';
import { useProviders } from '../provider-context';
import {
  editRequestOf,
  removeGeneration,
  retryGeneration,
  runAction,
  startEdit,
  trashResult,
  upscaleFile,
  type ResultContext,
} from '../studio-actions';
import { useStudio, useStudioSession } from '../studio-context';
import { editBlocked, hasImageProvider, imageModelOf } from '../studio-gate';
import { constrain } from '../studio-state';
import { ALERT, BORDER, ICON_BUTTON, MUTED, SECTION_TITLE } from '../ui';
import { CoverImage } from './CoverImage';
import { Dialog } from './Dialog';
import { PromptPicker } from './PromptPicker';
import { SavePromptDialog } from './SavePromptDialog';
import { StudioForm } from './StudioForm';
import { StudioResults } from './StudioResults';

/** The props of {@link GenerationStudio}. */
export interface GenerationStudioProps {
  /** The source image. */
  file: FileRecord;
  onClose(): void;
  /** Opens a result (or the source) in the file detail dialog; rejects when the file cannot be read. */
  onOpenFile(fileId: string): Promise<void>;
}

/**
 * The generation studio: edits and upscales of one image, in three columns (source, form, results).
 * The results of the file come from `generations:forFile` and are read again whenever the jobs
 * context's `changeToken` moves; a start keeps the form as it is.
 *
 * @param props the source image and the callbacks
 * @returns the dialog
 */
export function GenerationStudio({ file, onClose, onOpenFile }: GenerationStudioProps): JSX.Element | null {
  const providers = useProviders();
  const { changeToken, refresh } = useJobs();
  const { recallVariable, rememberVariables } = useStudio();
  const session = useStudioSession();
  const choice = useImageProviderChoice(file.id);
  const { providerId, model } = choice;

  const fieldsState = useStudioFields(file.id, session, choice);
  const { fields, picking, setPicking, saving, setSaving, pendingModel, setPendingModel } = fieldsState;
  const status = useStudioStatus(file.id, session, fieldsState);
  const { results, upscales, recent, selectedId, setSelectedId, startError, setStartError } = status;
  const { actionError, setActionError, loadError, promptRef, shownFileId, busy, setBusy, starting } = status;
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

  const reads = useStudioReads({
    fileId: file.id,
    results,
    selectedId,
    changeToken,
    sessionStarting: session.starting(file.id, 'edit'),
    setResults: status.setResults,
    setUpscales: status.setUpscales,
    setRecent: status.setRecent,
    setLoadError: status.setLoadError,
  });
  const { disposed, loadResults, loadUpscales, loadRecent, selectedFileId } = reads;

  const imageModel = imageModelOf(providers, providerId, model);
  const form = constrain({ ...fields, providerId, model }, imageModel);
  const blocked = editBlocked(providers, form, imageModel);
  const upscaleBlocked = providerId === null || !hasImageProvider(providers) ? NO_IMAGE_PROVIDER_TITLE : null;

  /** After a start, a retry or a removal: the jobs poll at once and the results are read again. */
  function changed() {
    refresh();
    void loadResults();
    void loadUpscales();
  }

  function generate() {
    if (blocked !== null || startBusy || providerId === null || model === null) return;
    const onStarted = () => {
      changed();
      void loadRecent();
    };
    const start = {
      session,
      fileId: file.id,
      disposed,
      setStarting: status.setStarting,
      setStartError,
      refresh,
      noteUsed: providers.noteUsed,
      onStarted,
    };
    void startEdit(start, editRequestOf(file.id, providerId, model, form));
  }

  const act = (action: () => Promise<void>) => runAction({ busy, setBusy, setActionError, disposed }, action);
  const context: ResultContext = { session, disposed, setActionError, refresh, noteUsed: providers.noteUsed, changed };
  const upscale = (fileId: string, scale: UpscaleScale) => act(() => upscaleFile(context, providerId, fileId, scale));
  const retry = (generation: Generation) => act(() => retryGeneration(context, generation));
  const remove = (generation: Generation) => act(() => removeGeneration(context, generation));
  const trash = (fileId: string) => act(() => trashResult(context, fileId, selectedFileId, () => setSelectedId(null)));
  const openResult = (fileId: string) => {
    setActionError(null);
    onOpenFile(fileId).catch(() => {
      if (!disposed.current) setActionError(LINKED_FILE_FAILED);
    });
  };

  const prompt = useStudioPrompt({
    fileId: file.id,
    form,
    fieldsState,
    setStartError,
    disposed,
    choice,
    providers,
    recallVariable,
    rememberVariables,
  });
  const { change, chooseRecent, setVariable, editText, loadCurrent, applySettings, pickPrompt, saved } = prompt;

  const title = `${STUDIO_TITLE} ${file.originalName}`;
  return (
    <Dialog open title={title} onClose={onClose} size="detail" initialFocusRef={promptRef}>
      <div className="flex h-full flex-col">
        <StudioHeader title={title} name={file.originalName} onClose={onClose} />
        <div className="flex min-h-0 flex-1">
          <section
            aria-label={SOURCE_IMAGE_LABEL}
            className={`flex w-80 shrink-0 flex-col gap-3 overflow-y-auto border-r p-5 ${BORDER}`}
          >
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
              onOpen={openResult}
              onUpscale={(fileId, scale) => void upscale(fileId, scale)}
              upscaleBlocked={upscaleBlocked}
              onUseSettings={applySettings}
              onDelete={(fileId) => void trash(fileId)}
              onRetry={(generation) => void retry(generation)}
              onRemove={(generation) => void remove(generation)}
              busy={busy || upscaleBusy(selectedFileId)}
            />
          </section>
        </div>
      </div>
      {picking && <PromptPicker onPick={pickPrompt} onClose={() => setPicking(false)} />}
      {saving && (
        <SavePromptDialog prompt={form.prompt} origin={form.origin} onSaved={saved} onClose={() => setSaving(false)} />
      )}
    </Dialog>
  );
}

/** The props of {@link StudioHeader}. */
interface StudioHeaderProps {
  /** The dialog title, also the heading's tooltip. */
  title: string;
  /** The name of the source image. */
  name: string;
  onClose(): void;
}

/**
 * The heading of the studio with its close button.
 *
 * @param props the title, the source name and the close callback
 * @returns the header
 */
function StudioHeader({ title, name, onClose }: StudioHeaderProps) {
  return (
    <header className={`flex shrink-0 items-center gap-4 border-b py-3 pl-5 pr-4 ${BORDER}`}>
      <h2 title={title} className={`${SECTION_TITLE} flex min-w-0 flex-1 items-center gap-3`}>
        <span className="shrink-0">{STUDIO_TITLE}</span>
        <span aria-hidden className={`h-5 shrink-0 border-l ${BORDER}`} />
        <span className="truncate font-normal">{name}</span>
      </h2>
      <button type="button" aria-label={CLOSE_LABEL} title={CLOSE_LABEL} className={ICON_BUTTON} onClick={onClose}>
        <X size={18} aria-hidden />
      </button>
    </header>
  );
}

/**
 * The source image large, with its name.
 *
 * @param props the source image
 * @returns the image and its name
 */
function CoverImageFrame({ file }: { file: FileRecord }) {
  return (
    <>
      <CoverImage
        fileId={file.id}
        size="detail"
        fallback={formatLabel(file.originalName)}
        className="aspect-square w-full"
      />
      <p title={file.originalName} className={`truncate text-sm ${MUTED}`}>
        {file.originalName}
      </p>
    </>
  );
}
