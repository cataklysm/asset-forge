import { cleanTagText, normalizeTagName, type TagAssignment } from '@assetforge/contracts';
import { Image as ImageIcon } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type Ref } from 'react';
import { describeError } from '../api';
import { ALERT, LABEL } from '../ui';
import { TagChip } from './TagChip';
import { TagCombobox } from './TagCombobox';

interface Props {
  label: 'Asset tags' | 'Image tags' | 'Shared image tags';
  kind: 'asset' | 'file';
  tags: readonly TagAssignment[];
  onAdd(displayName: string): Promise<void>;
  onRemove(name: string): Promise<void>;
  disabled?: boolean;
  inputRef?: Ref<HTMLInputElement>;
}

export const INVALID_TAG = 'Tags need a letter or digit and at most 64 characters.';

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === 'function') ref(value);
  else if (ref) ref.current = value;
}

/**
 * Editable tags of one owner: chips with remove and an input with suggestions. Backspace in the
 * empty input focuses the last chip; Delete or Backspace on a chip removes it and keeps focus in the row.
 */
export function TagRow({ label, kind, tags, onAdd, onRemove, disabled = false, inputRef }: Props) {
  const labelId = useId();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const removing = useRef(false);
  /** The chip being removed and its index, so that focus can move once it is gone. */
  const pendingFocus = useRef<{ name: string; index: number } | null>(null);

  const setInput = useCallback(
    (element: HTMLInputElement | null) => {
      input.current = element;
      assignRef(inputRef, element);
    },
    [inputRef],
  );

  const removeButtons = () => [...(rowRef.current?.querySelectorAll<HTMLButtonElement>('[data-chip] button') ?? [])];

  useEffect(() => {
    const pending = pendingFocus.current;
    if (pending === null || tags.some((tag) => tag.name === pending.name)) return;
    pendingFocus.current = null;
    const buttons = removeButtons();
    (buttons[pending.index] ?? buttons[pending.index - 1] ?? input.current)?.focus();
  }, [tags]);

  async function add(value: string) {
    if (cleanTagText(value) === '') return;
    if (normalizeTagName(value) === null) {
      setError(INVALID_TAG);
      return;
    }
    setError(null);
    try {
      await onAdd(cleanTagText(value));
      setText('');
    } catch (e) {
      setError(describeError(e));
    }
  }

  async function remove(name: string, index: number) {
    if (removing.current) return;
    removing.current = true;
    setError(null);
    pendingFocus.current = { name, index };
    try {
      await onRemove(name);
    } catch (e) {
      pendingFocus.current = null;
      setError(describeError(e));
    } finally {
      removing.current = false;
    }
  }

  function onInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Backspace' || event.currentTarget.value !== '') return;
    const last = removeButtons().at(-1);
    if (last === undefined) return;
    event.preventDefault();
    last.focus();
  }

  return (
    <div>
      <div ref={rowRef} role="group" aria-labelledby={labelId} className="flex flex-wrap items-center gap-1.5">
        <span id={labelId} className={`${LABEL} mr-1`}>
          {label}
        </span>
        {kind === 'file' && <ImageIcon size={16} aria-hidden className="shrink-0 text-muted" />}
        {tags.map((tag, index) => (
          <span
            key={tag.name}
            data-chip=""
            className="max-w-full"
            onKeyDown={(event) => {
              if (event.key !== 'Delete' && event.key !== 'Backspace') return;
              event.preventDefault();
              void remove(tag.name, index);
            }}
          >
            <TagChip tag={tag} onRemove={disabled ? undefined : () => void remove(tag.name, index)} />
          </span>
        ))}
        <TagCombobox
          value={text}
          onValueChange={(value) => {
            setText(value);
            setError(null);
          }}
          onCommit={(value) => void add(value)}
          placeholder="+ Add tag"
          label={kind === 'asset' ? 'Add asset tag' : 'Add image tag'}
          inputRef={setInput}
          onKeyDown={onInputKeyDown}
          disabled={disabled}
        />
      </div>
      {error !== null && (
        <p role="alert" className={`mt-2 ${ALERT}`}>
          {error}
        </p>
      )}
    </div>
  );
}
