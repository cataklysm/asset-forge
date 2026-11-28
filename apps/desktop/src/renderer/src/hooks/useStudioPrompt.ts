import { useRef, type MutableRefObject } from 'react';
import { purposeOf, type Generation, type PromptDetail, type PromptVersion } from '@assetforge/contracts';
import { call, messageOf } from '../api';
import type { ProviderChoice } from '../provider-choice';
import type { ProvidersState } from '../provider-context';
import { withVariable, type StudioFields } from '../studio-fields';
import { attach, preview } from '../studio-prompt';
import { formFromGeneration, writeSafeMode, type StudioForm } from '../studio-state';
import type { StudioFieldsState } from './useStudioFields';

/** What the prompt handling of the studio works with. */
export interface StudioPromptInput {
  fileId: string;
  /** The form as shown. */
  form: StudioForm;
  fieldsState: StudioFieldsState;
  setStartError(message: string | null): void;
  /** True once the studio unmounted. */
  disposed: MutableRefObject<boolean>;
  choice: ProviderChoice;
  providers: ProvidersState;
  /** The value typed last for a variable in this studio session. */
  recallVariable(name: string): string | undefined;
  rememberVariables(values: Readonly<Record<string, string>>): void;
}

/** The handlers of the prompt part of the studio form. */
export interface StudioPrompt {
  pickPrompt(promptId: string): Promise<void>;
  loadCurrent(): void;
  editText(): void;
  setVariable(name: string, value: string): void;
  chooseRecent(prompt: string): void;
  saved(detail: PromptDetail): void;
  applySettings(generation: Generation): void;
  change(patch: Partial<StudioFields>): void;
}

/** What one library load works with. */
interface PromptLoad {
  promptSeq: MutableRefObject<number>;
  disposed: MutableRefObject<boolean>;
  setFields: StudioFieldsState['setFields'];
  setStartError(message: string | null): void;
  recallVariable(name: string): string | undefined;
}

/**
 * Loads a library prompt and attaches the version `pickVersion` chooses.
 *
 * @param load the context
 * @param promptId the prompt
 * @param pickVersion chooses the version
 * @param given values that win over the remembered ones
 * @returns true once attached; false when superseded or the version is gone; rejects with a failed call
 */
async function loadPrompt(
  load: PromptLoad,
  promptId: string,
  pickVersion: (detail: PromptDetail) => PromptVersion | undefined,
  given: Readonly<Record<string, string>> = {},
): Promise<boolean> {
  const seq = ++load.promptSeq.current;
  const detail = await call('prompts:get', { promptId });
  if (load.disposed.current || seq !== load.promptSeq.current) return false;
  const version = pickVersion(detail);
  if (version === undefined) return false;
  load.setFields((current) => ({
    ...current,
    attached: attach(detail, version, load.recallVariable, given),
    origin: null,
  }));
  load.setStartError(null);
  return true;
}

/**
 * The fields a generation's settings give, without provider and model.
 *
 * @param next the form of the generation
 * @returns the fields
 */
const settingsFields = (next: StudioForm): StudioFields => ({
  prompt: next.prompt,
  attached: next.attached,
  origin: next.origin,
  aspectRatio: next.aspectRatio,
  resolution: next.resolution,
  safeMode: next.safeMode,
});

/**
 * Whether an entry is a listed image entry.
 *
 * @param providers the provider context
 * @param providerId the entry
 * @returns true when it is
 */
function isListedImageEntry(providers: ProvidersState, providerId: string | null): boolean {
  return (
    providers.list?.providers.some((entry) => entry.id === providerId && purposeOf(entry.kind) === 'image') ?? false
  );
}

/**
 * The prompt handling of the studio: library prompts, variables, recent prompts and "Use settings".
 * Only the newest library load may attach a prompt; a free text chosen since then wins.
 *
 * @param input the form, its setters and the session helpers
 * @returns the handlers
 */
export function useStudioPrompt(input: StudioPromptInput): StudioPrompt {
  const { fileId, form, fieldsState, setStartError, disposed, choice, providers } = input;
  const { setFields, setPicking, setSaving, setPendingModel } = fieldsState;
  const promptSeq = useRef(0);
  // A file change supersedes a load in flight during the render that shows the new file, so no answer for the
  // old file can attach before an effect would run.
  const shownFile = useRef(fileId);
  if (shownFile.current !== fileId) {
    shownFile.current = fileId;
    promptSeq.current += 1;
  }
  const load: PromptLoad = { promptSeq, disposed, setFields, setStartError, recallVariable: input.recallVariable };

  async function pickPrompt(promptId: string) {
    if (await loadPrompt(load, promptId, (detail) => detail.currentVersion)) setPicking(false);
  }

  function loadCurrent() {
    const attached = form.attached;
    if (attached === null) return;
    loadPrompt(load, attached.promptId, (detail) => detail.currentVersion, attached.values).catch((error: unknown) => {
      if (!disposed.current) setStartError(messageOf(error));
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
    input.rememberVariables({ [name]: value });
    setStartError(null);
    setFields((current) => withVariable(current, name, value));
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
    setFields((current) => ({
      ...current,
      attached: attach(detail, detail.currentVersion, input.recallVariable),
      origin: null,
    }));
  }

  function applySettings(generation: Generation) {
    const next = formFromGeneration(generation, form);
    setFields(settingsFields(next));
    setStartError(null);
    if (generation.kind === 'edit') {
      const { promptId, promptVersionId } = generation;
      if (promptId !== null && promptVersionId !== null) {
        // A prompt that is gone (or cannot be read) leaves its resolved text as the free prompt.
        const pickVersion = (detail: PromptDetail) => detail.versions.find((version) => version.id === promptVersionId);
        loadPrompt(load, promptId, pickVersion, generation.promptVariables ?? {}).catch(() => {});
      } else promptSeq.current += 1;
    }
    setPendingModel(null);
    if (next.providerId === choice.providerId) {
      if (next.model !== choice.model) choice.setModel(next.model);
      return;
    }
    // A result of an entry that is gone (or no longer an image entry) keeps the selected entry and model.
    if (next.providerId !== null && isListedImageEntry(providers, next.providerId)) {
      choice.setProvider(next.providerId);
      setPendingModel({ providerId: next.providerId, model: next.model });
    }
  }

  function change(patch: Partial<StudioFields>) {
    if (patch.safeMode !== undefined) writeSafeMode(patch.safeMode);
    setStartError(null);
    setFields((current) => ({ ...current, ...patch }));
  }

  return { pickPrompt, loadCurrent, editText, setVariable, chooseRecent, saved, applySettings, change };
}
