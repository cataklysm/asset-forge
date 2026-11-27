import { cleanTagText, normalizeTagName, type TagAssignment } from '@assetforge/contracts';
import { Image as ImageIcon } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type Ref } from 'react';
import { describeError } from '../api';
import type { TagRename } from '../tag-rename';
import { useTags } from '../tags-context';
import { ALERT, LABEL, PANEL_TITLE } from '../ui';
import { TagChip } from './TagChip';
import { TagCombobox } from './TagCombobox';

interface Props {
  label: 'Asset tags' | 'Image tags' | 'File tags' | 'Shared image tags' | 'Prompt tags';
  kind: 'asset' | 'file' | 'prompt';
  /**
   * `inline` (the default): label, chips and a boxed input in one wrapping row. `stacked`: the label
   * as a panel heading, the chips below it and the input as an action after them.
   */
  layout?: 'inline' | 'stacked';
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
export function TagRow({ label, kind, layout = 'inline', tags, onAdd, onRemove, disabled = false, inputRef }: Props) {
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

  const { openRename } = useTags();
  const removeButtons = () => [
    ...(rowRef.current?.querySelectorAll<HTMLButtonElement>('[data-chip] button[data-remove]') ?? []),
  ];

  /** A finished rename started from a pencil of this row, until its chip has focus again. */
  const renamedFocus = useRef<TagRename | null>(null);

  useEffect(() => {
    const renamed = renamedFocus.current;
    // The chip of the old name unmounts once the rename reaches the row; focus moves to the new one.
    if (renamed !== null && !tags.some((tag) => tag.name === renamed.from)) {
      renamedFocus.current = null;
      const index = tags.findIndex((tag) => tag.name === renamed.name);
      const chip = index < 0 ? undefined : rowRef.current?.querySelectorAll('[data-chip]')[index];
      (chip?.querySelector<HTMLButtonElement>('button[data-rename]') ?? input.current)?.focus();
    }
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

  const stacked = layout === 'stacked';
  const icon = kind === 'file' && <ImageIcon size={16} aria-hidden className="shrink-0 text-muted" />;
  return (
    <div className={stacked ? 'space-y-2' : undefined}>
      {stacked && (
        <div className="flex items-center gap-2">
          <h3 id={labelId} className={PANEL_TITLE}>
            {label}
          </h3>
          {icon}
        </div>
      )}
      <div ref={rowRef} role="group" aria-labelledby={labelId} className="flex flex-wrap items-center gap-1.5">
        {!stacked && (
          <>
            <span id={labelId} className={`${LABEL} mr-1`}>
              {label}
            </span>
            {icon}
          </>
        )}
        {tags.map((tag, index) => (
          <span
            key={tag.name}
            data-chip=""
            className="max-w-full"
            onKeyDown={(event) => {
              if (event.key !== 'Delete' && event.key !== 'Backspace') return;
              // The pencil renames; only the chip and its remove button remove.
              if (event.target instanceof Element && event.target.closest('[data-rename]') !== null) return;
              event.preventDefault();
              void remove(tag.name, index);
            }}
          >
            <TagChip
              tag={tag}
              onRemove={disabled ? undefined : () => void remove(tag.name, index)}
              onRename={
                disabled || openRename === null
                  ? undefined
                  : () =>
                      openRename({ name: tag.name, displayName: tag.displayName }, (change) => {
                        // Another spelling keeps the chip and its key; the dialog gives the pencil its focus back.
                        renamedFocus.current = change.from !== change.name ? change : null;
                      })
              }
            />
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
          label={kind === 'asset' ? 'Add asset tag' : kind === 'prompt' ? 'Add prompt tag' : 'Add image tag'}
          inputRef={setInput}
          onKeyDown={onInputKeyDown}
          disabled={disabled}
          look={stacked ? 'inline' : 'box'}
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
