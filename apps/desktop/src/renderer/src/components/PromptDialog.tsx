import { useEffect, useRef, useState } from 'react';
import { JOB_ERROR_MESSAGES, type FileRecord } from '@assetforge/contracts';
import { call, describeError } from '../api';
import { useProvider } from '../provider-context';
import { providerGate } from '../provider-gate';
import { ALERT, BUTTON, FOCUS } from '../ui';
import { Dialog } from './Dialog';
import { ModelSelect } from './ModelSelect';
import { SettingsButton } from './SettingsButton';

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

export const PROMPT_DIALOG_TITLE = 'Image to prompt';
/** Shown when the main process is already describing another image. */
export const PROMPT_BUSY_MESSAGE = 'Another prompt is being generated';
const COPY_FAILED_MESSAGE = 'The text could not be copied';
const GENERATING_TITLE = 'The prompt is being generated';
const NO_FILE_TITLE = 'No image to describe';

/**
 * Image2Prompt: describes one image with a chosen model and shows the text to copy. The text lives
 * only in this dialog's state; it is dropped when the dialog closes or another file is shown, and
 * a request still running then is cancelled.
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

function PromptBody({ file, onClose, onOpenSettings, settingsBlocked = null }: Omit<Props, 'open'>) {
  const provider = useProvider();
  const { settings } = provider;
  // Null until the user picks one: until then the stored prompt default is shown.
  const [chosen, setChosen] = useState<{ model: string | null } | null>(null);
  const [running, setRunning] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The request whose answer is still wanted; any other answer is dropped.
  const request = useRef<string | null>(null);

  const model = chosen !== null ? chosen.model : (settings?.promptModel ?? null);
  const configured = settings !== null && settings.baseUrl !== null;
  const gate = providerGate(provider, model);

  const blockedTitle = gate.blocked ?? (running ? GENERATING_TITLE : file === null ? NO_FILE_TITLE : undefined);
  const canGenerate = gate.blocked === null && !running && file !== null && model !== null;

  function cancel() {
    const requestId = request.current;
    request.current = null;
    setRunning(false);
    if (requestId !== null) void call('analysis:cancelDescribe', { requestId }).catch(() => {});
  }

  // Closing the dialog or switching the file unmounts the body: a running request is cancelled.
  useEffect(() => () => cancel(), []);

  async function generate() {
    if (!canGenerate || file === null || model === null) return;
    const requestId = crypto.randomUUID();
    request.current = requestId;
    setRunning(true);
    setText(null);
    setError(null);
    try {
      const result = await call('analysis:describe', { requestId, fileId: file.id, model });
      if (request.current !== requestId) return;
      if (result.ok) setText(result.text);
      else if (result.code === 'busy') setError(PROMPT_BUSY_MESSAGE);
      else if (result.code !== 'cancelled') setError(JOB_ERROR_MESSAGES[result.code]);
    } catch (e) {
      if (request.current === requestId) setError(describeError(e));
    } finally {
      if (request.current === requestId) {
        request.current = null;
        setRunning(false);
      }
    }
  }

  async function copy() {
    if (text === null) return;
    try {
      await navigator.clipboard.writeText(text);
      // A copy that works drops the message of an earlier one that failed.
      setError((current) => (current === COPY_FAILED_MESSAGE ? null : current));
    } catch {
      setError(COPY_FAILED_MESSAGE);
    }
  }

  function openSettings() {
    if (settingsBlocked !== null) return;
    onClose();
    onOpenSettings();
  }

  return (
    <div className="flex flex-col gap-3">
      <ModelSelect
        purpose="prompt"
        value={model}
        onChange={(next) => setChosen({ model: next })}
        disabled={running || !configured}
      />
      <div className="flex gap-2">
        <button
          type="button"
          className={BUTTON}
          disabled={!canGenerate}
          title={blockedTitle}
          onClick={() => void generate()}
        >
          Generate
        </button>
        {running && (
          <button type="button" className={BUTTON} onClick={cancel}>
            Cancel
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
        aria-label="Prompt"
        readOnly
        aria-busy={running || undefined}
        value={text ?? ''}
        className={`h-48 w-full resize-none rounded-control border border-line bg-surface p-2.5 text-text ${FOCUS}`}
      />
      <div className="flex justify-end gap-2">
        <button type="button" className={BUTTON} disabled={text === null} onClick={() => void copy()}>
          Copy
        </button>
        <button type="button" className={BUTTON} onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
