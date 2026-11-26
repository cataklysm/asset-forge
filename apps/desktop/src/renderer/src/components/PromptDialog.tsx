import { useEffect, useRef, useState } from 'react';
import { JOB_ERROR_MESSAGES, type FileRecord } from '@assetforge/contracts';
import { call, describeError } from '../api';
import { useProvider } from '../provider-context';
import { ALERT, BUTTON, FOCUS } from '../ui';
import { Dialog } from './Dialog';
import { ModelSelect } from './ModelSelect';

interface Props {
  open: boolean;
  /** The image to describe; Generate is disabled without one. */
  file: FileRecord | null;
  onClose(): void;
  /** Shows the settings screen; the dialog asks to be closed first. */
  onOpenSettings(): void;
}

export const PROMPT_DIALOG_TITLE = 'Image to prompt';
/** Shown when the main process is already describing another image. */
export const PROMPT_BUSY_MESSAGE = 'Another prompt is being generated';
const NO_PROMPT_MODEL_TITLE = 'Choose a prompt model';
const NO_VISION_MODEL_TITLE = 'The provider offers no model that can read images';
const COPY_FAILED_MESSAGE = 'The text could not be copied';

/**
 * Image2Prompt: describes one image with a chosen model and shows the text to copy. The text lives
 * only in this dialog's state; it is dropped when the dialog closes or another file is shown, and
 * a request still running then is cancelled.
 */
export function PromptDialog({ open, file, onClose, onOpenSettings }: Props) {
  return (
    <Dialog open={open} title={PROMPT_DIALOG_TITLE} onClose={onClose}>
      {/* Rendered only while open; a new file starts from scratch. */}
      <PromptBody key={file?.id ?? ''} file={file} onClose={onClose} onOpenSettings={onOpenSettings} />
    </Dialog>
  );
}

function PromptBody({ file, onClose, onOpenSettings }: Omit<Props, 'open'>) {
  const { settings, models, loading } = useProvider();
  // Null until the user picks one: until then the stored prompt default is shown.
  const [chosen, setChosen] = useState<{ model: string | null } | null>(null);
  const [running, setRunning] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The request whose answer is still wanted; any other answer is dropped.
  const request = useRef<string | null>(null);

  const model = chosen !== null ? chosen.model : (settings?.promptModel ?? null);
  const configured = settings !== null && settings.baseUrl !== null;
  const notConfigured = !loading && !configured;
  const noVisionModel = models !== null && models.ok && models.models.every((m) => m.vision === false);
  const modelRefused =
    models !== null && models.ok && models.models.some((m) => m.name === model && m.vision === false);

  const blockedTitle = notConfigured
    ? JOB_ERROR_MESSAGES.provider_not_configured
    : !configured
      ? undefined
      : noVisionModel
        ? NO_VISION_MODEL_TITLE
        : model === null || modelRefused
          ? NO_PROMPT_MODEL_TITLE
          : undefined;
  const canGenerate = configured && !running && file !== null && model !== null && !modelRefused && !noVisionModel;

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
    } catch {
      setError(COPY_FAILED_MESSAGE);
    }
  }

  function openSettings() {
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
        {(notConfigured || noVisionModel) && (
          <button type="button" className={BUTTON} onClick={openSettings}>
            Settings
          </button>
        )}
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
