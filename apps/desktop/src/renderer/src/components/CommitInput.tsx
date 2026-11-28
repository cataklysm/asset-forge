import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { FOCUS, INPUT } from '../ui';

/** The props of `CommitInput`. */
interface Props {
  /** The saved value; a new one replaces the draft. */
  value: string;
  /** Return `false` (or resolve to `false`) when saving failed: the field then shows the saved value again. */
  onCommit(value: string): void | boolean | Promise<boolean | void>;
  /** The accessible name. */
  label: string;
  /** A textarea instead of a single-line input. */
  multiline?: boolean;
  /** The most characters the field takes. */
  maxLength: number;
  /** `inline` is borderless until hover or focus; a multiline inline field shows one line until focused. */
  variant?: 'field' | 'inline';
  placeholder?: string;
  /** Extra classes, e.g. the type size of an inline title. */
  className?: string;
}

/** The classes of the `inline` variant. */
const INLINE = `min-w-0 rounded-control border border-transparent bg-transparent px-2 text-text placeholder:text-muted hover:border-line focus:border-line focus:bg-surface ${FOCUS}`;

/**
 * Text input or textarea that commits on blur and on Enter (Ctrl+Enter in a textarea), only when the value changed.
 *
 * @param props the saved value, the commit callback, the label, the look and the limits
 * @returns the input or textarea
 */
export function CommitInput({
  value,
  onCommit,
  label,
  multiline = false,
  maxLength,
  variant = 'field',
  placeholder,
  className = '',
}: Props) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  // Enter followed by blur must not save the same text twice.
  const saving = useRef(false);

  useEffect(() => setDraft(value), [value]);

  async function commit() {
    if (draft === value || saving.current) return;
    saving.current = true;
    let result: boolean | void;
    try {
      result = await onCommit(draft);
    } catch {
      result = false;
    } finally {
      saving.current = false;
    }
    if (result === false) setDraft(value);
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key !== 'Enter') return;
    if (multiline && !event.ctrlKey) return;
    event.preventDefault();
    void commit();
  }

  const inline = variant === 'inline';
  const common = {
    className: `${inline ? INLINE : INPUT} ${className}`,
    'aria-label': label,
    value: draft,
    maxLength,
    placeholder,
    onChange: (event: { target: { value: string } }) => setDraft(event.target.value),
    onFocus: () => setFocused(true),
    onBlur: () => {
      setFocused(false);
      void commit();
    },
    onKeyDown,
  };
  if (!multiline) return <input type="text" {...common} />;
  const rows = inline && !focused ? 1 : 3;
  return <textarea rows={rows} {...common} className={`${common.className} ${inline ? 'resize-none py-1.5' : ''}`} />;
}
