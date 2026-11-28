import { useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { JOB_ERROR_MESSAGES, type FileRecord } from '@assetforge/contracts';
import { effectivePromptId, useAnalysisPrompts, type AnalysisPromptsState } from '../analysis-prompts-context';
import { ApiError, call, describeError } from '../api';
import {
  CANCEL_LABEL,
  CLOSE_LABEL,
  COPY_FAILED_MESSAGE,
  COPY_LABEL,
  DESCRIBE_LABEL,
  GENERATING_TITLE,
  NO_FILE_TITLE,
  PROMPT_BUSY_MESSAGE,
  PROMPT_DIALOG_TITLE,
  PROMPT_RESULT_LABEL,
} from '../labels';
import { useProviderChoice } from '../provider-choice';
import { useProviders, type ProvidersState } from '../provider-context';
import { promptGate, providerGate } from '../provider-gate';
import { ALERT, BUTTON, FOCUS } from '../ui';
import { Dialog } from './Dialog';
import { ModelSelect } from './ModelSelect';
import { ProviderSelect } from './ProviderSelect';
import { PromptSelect } from './PromptSelect';
import { SettingsButton } from './SettingsButton';

/** The props of `PromptDialog`. */
interface Props {
  open: boolean;
  /** The image to describe; Generate is disabled without one. */
  file: FileRecord | null;
  onClose(): void;
  /** Shows the settings screen; the dialog asks to be closed first. */
  onOpenSettings(): void;
  /** Why the settings screen cannot be shown now (Settings is disabled with it); null when it can. */
  settingsBlocked?: string | null;
}

export { PROMPT_BUSY_MESSAGE } from '../labels';

/**
 * Image2Prompt: describes one image with a chosen provider and model and shows the text to copy.
 * The text lives only in this dialog's state; it is dropped when the dialog closes or another file
 * is shown, and a request still running then is cancelled.
 *
 * @param props the file, whether it is open and the handlers
 */
export function PromptDialog({ open, file, onClose, onOpenSettings, settingsBlocked = null }: Props) {
  return (
    <Dialog open={open} title={PROMPT_DIALOG_TITLE} onClose={onClose}>
      {/* Rendered only while open; a new file starts from scratch. */}
      <PromptBody
        key={file?.id ?? ''}
        file={file}
        onClose={onClose}
        onOpenSettings={onOpenSettings}
        settingsBlocked={settingsBlocked}
      />
    </Dialog>
  );
}

/**
 * The tooltip of Generate.
 *
 * @param blocked why no request can start; null when one can
 * @param running whether a request runs
 * @param hasFile whether there is a file to describe
 * @returns the tooltip, or undefined for none
 */
function generateTitle(blocked: string | null, running: boolean, hasFile: boolean): string | undefined {
  if (blocked !== null) return blocked;
  if (running) return GENERATING_TITLE;
  return hasFile ? undefined : NO_FILE_TITLE;
}

/** The request of one describe. */
interface DescribeRequest {
  fileId: string;
  model: string;
  providerId: string;
  promptId: string;
}

/** What a describe sets and records. */
interface DescribeEffects {
  /** The request whose answer is still wanted. */
  request: MutableRefObject<string | null>;
  setRunning(running: boolean): void;
  setText(text: string | null): void;
  setError(message: string | null): void;
  /** Drops the owner's prompt pick. */
  dropChosenPrompt(): void;
  prompts: AnalysisPromptsState;
  providers: ProvidersState;
}

/**
 * Describes the image; only the answer of the request still wanted is shown.
 *
 * @param effects the request ref, the setters and where the start is recorded
 * @param describe the request
 * @returns resolves once done; never rejects
 */
async function describeImage(effects: DescribeEffects, describe: DescribeRequest): Promise<void> {
  const { request, prompts, providers } = effects;
  const requestId = crypto.randomUUID();
  request.current = requestId;
  effects.setRunning(true);
  effects.setText(null);
  effects.setError(null);
  try {
    const result = await call('analysis:describe', { requestId, ...describe });
    // Every answer but `busy` means the describe started; a cancelled one too, also after closing.
    if (result.ok || result.code !== 'busy') {
      prompts.noteUsed('image_prompt', describe.promptId);
      providers.noteUsed(describe.providerId);
    }
    if (request.current !== requestId) return;
    if (result.ok) effects.setText(result.text);
    else if (result.code === 'busy') effects.setError(PROMPT_BUSY_MESSAGE);
    else if (result.code !== 'cancelled') effects.setError(JOB_ERROR_MESSAGES[result.code]);
  } catch (error) {
    // The prompt may have been deleted meanwhile: list again and fall back to one that exists.
    if (error instanceof ApiError && error.code === 'not_found') {
      void prompts.reload().catch(() => {});
      if (request.current === requestId) effects.dropChosenPrompt();
    }
    if (request.current === requestId) effects.setError(describeError(error));
  } finally {
    if (request.current === requestId) {
      request.current = null;
      effects.setRunning(false);
    }
  }
}

/**
 * Copies the text; a copy that works drops the message of an earlier one that failed.
 *
 * @param text the text
 * @param setError the setter of the message
 * @returns resolves once done; never rejects
 */
async function copyText(text: string, setError: Dispatch<SetStateAction<string | null>>): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    setError((current) => (current === COPY_FAILED_MESSAGE ? null : current));
  } catch {
    setError(COPY_FAILED_MESSAGE);
  }
}

/**
 * Whether the focus has no place a user could act on: nothing, the body, or an element that was
 * removed or disabled.
 *
 * @returns true when the focus is lost
 */
function focusLost(): boolean {
  const active = document.activeElement;
  if (active === null || active === document.body || !active.isConnected) return true;
  return active instanceof HTMLButtonElement && active.disabled;
}

/** The buttons the focus moves between while a request starts and ends. */
interface RunningFocusTargets {
  generate: MutableRefObject<HTMLButtonElement | null>;
  cancel: MutableRefObject<HTMLButtonElement | null>;
  /** Takes the focus when a request ends and Generate stays disabled. */
  close: MutableRefObject<HTMLButtonElement | null>;
}

/**
 * Keeps the focus inside the dialog when a request starts (Generate is disabled: Cancel takes it)
 * and ends (Cancel is removed: Generate, or Close while Generate stays disabled, takes it). A focus
 * the user moved elsewhere is left alone.
 *
 * @param running whether a request runs
 * @param targets the buttons
 */
function useRunningFocus(running: boolean, targets: RunningFocusTargets): void {
  const previous = useRef(running);
  useEffect(() => {
    if (previous.current === running) return;
    previous.current = running;
    if (!focusLost()) return;
    const generate = targets.generate.current;
    const fallback = generate !== null && !generate.disabled ? generate : targets.close.current;
    const target = running ? targets.cancel.current : fallback;
    target?.focus();
  }, [running, targets]);
}

/**
 * The body of the dialog, mounted per opening and file.
 *
 * @param props the file and the handlers
 */
function PromptBody({ file, onClose, onOpenSettings, settingsBlocked = null }: Omit<Props, 'open'>) {
  const providers = useProviders();
  const prompts = useAnalysisPrompts();
  // The body is mounted per opening and file: it starts from the entry used last and its prompt default.
  const choice = useProviderChoice('prompt', 'open');
  const { providerId, model } = choice;
  // Null until the user picks one: until then the Image to prompt prompt used last (or the first).
  const [chosenPrompt, setChosenPrompt] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The request whose answer is still wanted; any other answer is dropped.
  const request = useRef<string | null>(null);
  const generateButton = useRef<HTMLButtonElement | null>(null);
  const cancelButton = useRef<HTMLButtonElement | null>(null);
  const closeButton = useRef<HTMLButtonElement | null>(null);
  const focusTargets = useRef<RunningFocusTargets>({
    generate: generateButton,
    cancel: cancelButton,
    close: closeButton,
  });
  useRunningFocus(running, focusTargets.current);

  const promptId = effectivePromptId(prompts, 'image_prompt', chosenPrompt);
  const gate = providerGate(providers, providerId, model, 'prompt');
  const blocked = gate.blocked ?? promptGate(prompts, promptId, 'image_prompt');
  const canGenerate =
    blocked === null && !running && file !== null && providerId !== null && model !== null && promptId !== null;

  /** Drops the answer of the running request and cancels it. */
  function cancel() {
    const requestId = request.current;
    request.current = null;
    setRunning(false);
    if (requestId !== null) void call('analysis:cancelDescribe', { requestId }).catch(() => {});
  }

  // Closing the dialog or switching the file unmounts the body: a running request is cancelled.
  useEffect(() => () => cancel(), []);

  /** Starts a describe unless one cannot start. */
  function generate() {
    if (!canGenerate || file === null || providerId === null || model === null || promptId === null) return;
    const effects: DescribeEffects = {
      request,
      setRunning,
      setText,
      setError,
      dropChosenPrompt: () => setChosenPrompt(null),
      prompts,
      providers,
    };
    void describeImage(effects, { fileId: file.id, model, providerId, promptId });
  }

  /** Ignored while the settings screen cannot be shown. */
  function openSettings() {
    if (settingsBlocked !== null) return;
    onClose();
    onOpenSettings();
  }

  return (
    <div className="flex flex-col gap-3">
      <ProviderSelect value={providerId} onChange={choice.setProvider} disabled={running} />
      <ModelSelect
        providerId={providerId}
        purpose="prompt"
        value={model}
        onChange={choice.setModel}
        disabled={running || providerId === null}
      />
      <PromptSelect purpose="image_prompt" value={promptId} onChange={setChosenPrompt} disabled={running} />
      <div className="flex gap-2">
        <button
          ref={generateButton}
          type="button"
          className={BUTTON}
          disabled={!canGenerate}
          title={generateTitle(blocked, running, file !== null)}
          onClick={generate}
        >
          {DESCRIBE_LABEL}
        </button>
        {running && (
          <button ref={cancelButton} type="button" className={BUTTON} onClick={cancel}>
            {CANCEL_LABEL}
          </button>
        )}
        {gate.offerSettings && <SettingsButton blocked={settingsBlocked} onClick={openSettings} />}
      </div>
      {error !== null && (
        <p role="alert" className={ALERT}>
          {error}
        </p>
      )}
      <textarea
        aria-label={PROMPT_RESULT_LABEL}
        readOnly
        aria-busy={running || undefined}
        value={text ?? ''}
        className={`h-48 w-full resize-none rounded-control border border-line bg-surface p-2.5 text-text ${FOCUS}`}
      />
      <div className="flex justify-end gap-2">
        <button
          type="button"
          className={BUTTON}
          disabled={text === null}
          onClick={() => {
            if (text !== null) void copyText(text, setError);
          }}
        >
          {COPY_LABEL}
        </button>
        <button ref={closeButton} type="button" className={BUTTON} onClick={onClose}>
          {CLOSE_LABEL}
        </button>
      </div>
    </div>
  );
}
