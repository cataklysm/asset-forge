import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import type { PromptDetail } from '@assetforge/contracts';
import { call, messageOf } from '../api';
import {
  CANCEL_LABEL,
  NEW_LIBRARY_PROMPT_LABEL,
  newVersionOfLabel,
  PROMPT_TITLE_LABEL,
  SAVE_LABEL,
  SAVE_TO_LIBRARY_LABEL,
} from '../labels';
import { ALERT, BUTTON, FOCUS, INPUT, LABEL } from '../ui';
import { Dialog } from './Dialog';

/** The props of {@link SavePromptDialog}. */
interface Props {
  /** The free prompt to save. */
  prompt: string;
  /** The library prompt the text was detached from; offered as a new version while it still exists. */
  origin: { promptId: string; title: string } | null;
  /** The saved prompt; its current version holds the text. */
  onSaved(detail: PromptDetail): void;
  onClose(): void;
}

/** How the text is saved: as a new version of the origin, or as a new prompt. */
type SaveMode = 'version' | 'new';

/**
 * Stores the text: as a new version of the origin, keeping its defaults, or as a new prompt with the title.
 *
 * @param prompt the text
 * @param title the title of a new prompt
 * @param origin the origin as it is now, when the text becomes a new version of it; else null
 * @returns the saved prompt
 */
function storePrompt(prompt: string, title: string, origin: PromptDetail | null): Promise<PromptDetail> {
  if (origin === null) return call('prompts:create', { title, description: '', content: prompt, defaults: {} });
  return call('prompts:saveVersion', {
    promptId: origin.id,
    baseVersionId: origin.currentVersion.id,
    content: prompt,
    defaults: Object.fromEntries(
      origin.currentVersion.variables.map((variable) => [variable.name, variable.defaultValue]),
    ),
  });
}

/** The props of {@link SaveModeChoice}. */
interface SaveModeChoiceProps {
  /** The title of the origin. */
  title: string;
  mode: SaveMode;
  onMode(mode: SaveMode): void;
  /** The radio of the new version. */
  versionRef: RefObject<HTMLInputElement | null>;
}

/**
 * The choice between a new version of the origin and a new prompt.
 *
 * @param props the origin's title, the mode, the callback and the ref of the version radio
 * @returns the radio group
 */
function SaveModeChoice({ title, mode, onMode, versionRef }: SaveModeChoiceProps) {
  return (
    <fieldset className="flex flex-col gap-2 text-sm text-text">
      <label className="inline-flex items-center gap-2">
        <input
          ref={versionRef}
          type="radio"
          name="save-as"
          className={`accent-accent ${FOCUS}`}
          checked={mode === 'version'}
          onChange={() => onMode('version')}
        />
        {newVersionOfLabel(title)}
      </label>
      <label className="inline-flex items-center gap-2">
        <input
          type="radio"
          name="save-as"
          className={`accent-accent ${FOCUS}`}
          checked={mode === 'new'}
          onChange={() => onMode('new')}
        />
        {NEW_LIBRARY_PROMPT_LABEL}
      </label>
    </fieldset>
  );
}

/**
 * Saves a free studio prompt to the library: as a new prompt, or as a new version of the prompt it came from.
 *
 * @param props the text, its origin and the callbacks
 * @returns the dialog
 */
export function SavePromptDialog({ prompt, origin, onSaved, onClose }: Props) {
  const titleId = useId();
  const titleRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState('');
  // The origin as it is now; null when there is none or it is gone.
  const [found, setFound] = useState<PromptDetail | null>(null);
  const [looking, setLooking] = useState(origin !== null);
  const [mode, setMode] = useState<SaveMode>('version');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const disposed = useRef(false);
  useEffect(() => {
    disposed.current = false;
    return () => {
      disposed.current = true;
    };
  }, []);

  const originId = origin?.promptId ?? null;
  useEffect(() => {
    if (originId === null) return;
    call('prompts:get', { promptId: originId })
      .then((detail) => {
        if (!disposed.current) setFound(detail);
      })
      .catch(() => {
        // A prompt that is gone (or cannot be read) is not offered; the text becomes a new prompt.
      })
      .finally(() => {
        if (!disposed.current) setLooking(false);
      });
  }, [originId]);

  const asVersion = found !== null && mode === 'version';
  const blocked = looking || saving || (!asVersion && title.trim() === '');

  // The title field takes the first focus; once it is disabled for a new version the focus moves to that choice.
  const versionRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!asVersion) return;
    const active = document.activeElement;
    if (active === titleRef.current || active === document.body || active === null) versionRef.current?.focus();
  }, [asVersion]);

  async function save() {
    if (blocked) return;
    setSaving(true);
    setError(null);
    try {
      const detail = await storePrompt(prompt, title, asVersion ? found : null);
      if (!disposed.current) onSaved(detail);
    } catch (caught) {
      if (!disposed.current) setError(messageOf(caught));
    } finally {
      if (!disposed.current) setSaving(false);
    }
  }

  return (
    <Dialog open title={SAVE_TO_LIBRARY_LABEL} onClose={onClose} initialFocusRef={titleRef}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {found !== null && <SaveModeChoice title={found.title} mode={mode} onMode={setMode} versionRef={versionRef} />}
        <label htmlFor={titleId} className={LABEL}>
          {PROMPT_TITLE_LABEL}
        </label>
        <input
          id={titleId}
          ref={titleRef}
          className={INPUT}
          value={title}
          disabled={asVersion}
          onChange={(event) => setTitle(event.target.value)}
        />
        {error !== null && (
          <p role="alert" className={ALERT}>
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className={BUTTON} onClick={onClose}>
            {CANCEL_LABEL}
          </button>
          <button type="submit" className={BUTTON} disabled={blocked}>
            {SAVE_LABEL}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
