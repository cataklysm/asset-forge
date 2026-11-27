import { useEffect, useId, useRef, useState } from 'react';
import type { PromptDetail } from '@assetforge/contracts';
import { ApiError, call, describeError } from '../api';
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

interface Props {
  /** The free prompt to save. */
  prompt: string;
  /** The library prompt the text was detached from; offered as a new version while it still exists. */
  origin: { promptId: string; title: string } | null;
  /** The saved prompt; its current version holds the text. */
  onSaved(detail: PromptDetail): void;
  onClose(): void;
}

/** A message of a failed call: fixed main-process messages as sent, anything else described. */
function messageOf(error: unknown): string {
  return error instanceof ApiError && error.code !== 'internal_error' ? error.message : describeError(error);
}

/** Saves a free studio prompt to the library: as a new prompt, or as a new version of the prompt it came from. */
export function SavePromptDialog({ prompt, origin, onSaved, onClose }: Props) {
  const titleId = useId();
  const titleRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState('');
  // The origin as it is now; null when there is none or it is gone.
  const [found, setFound] = useState<PromptDetail | null>(null);
  const [looking, setLooking] = useState(origin !== null);
  const [mode, setMode] = useState<'version' | 'new'>('version');
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

  async function save() {
    if (blocked) return;
    setSaving(true);
    setError(null);
    try {
      const detail =
        asVersion && found !== null
          ? await call('prompts:saveVersion', {
              promptId: found.id,
              baseVersionId: found.currentVersion.id,
              content: prompt,
              defaults: Object.fromEntries(found.currentVersion.variables.map((v) => [v.name, v.defaultValue])),
            })
          : await call('prompts:create', { title, description: '', content: prompt, defaults: {} });
      if (!disposed.current) onSaved(detail);
    } catch (e) {
      if (!disposed.current) setError(messageOf(e));
    } finally {
      if (!disposed.current) setSaving(false);
    }
  }

  return (
    <Dialog open title={SAVE_TO_LIBRARY_LABEL} onClose={onClose} initialFocusRef={titleRef}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {found !== null && (
          <fieldset className="flex flex-col gap-2 text-sm text-text">
            <label className="inline-flex items-center gap-2">
              <input
                type="radio"
                name="save-as"
                className={`accent-accent ${FOCUS}`}
                checked={mode === 'version'}
                onChange={() => setMode('version')}
              />
              {newVersionOfLabel(found.title)}
            </label>
            <label className="inline-flex items-center gap-2">
              <input
                type="radio"
                name="save-as"
                className={`accent-accent ${FOCUS}`}
                checked={mode === 'new'}
                onChange={() => setMode('new')}
              />
              {NEW_LIBRARY_PROMPT_LABEL}
            </label>
          </fieldset>
        )}
        <label htmlFor={titleId} className={LABEL}>
          {PROMPT_TITLE_LABEL}
        </label>
        <input
          id={titleId}
          ref={titleRef}
          className={INPUT}
          value={title}
          disabled={asVersion}
          onChange={(e) => setTitle(e.target.value)}
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
