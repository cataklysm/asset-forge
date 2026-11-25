import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { INPUT } from '../ui';

interface Props {
  value: string;
  /** Return `false` (or resolve to `false`) when saving failed: the field then shows the saved value again. */
  onCommit(value: string): void | boolean | Promise<boolean | void>;
  label: string;
  multiline?: boolean;
  maxLength: number;
}

/** Text input or textarea that commits on blur and on Enter (Ctrl+Enter in a textarea), only when the value changed. */
export function CommitInput({ value, onCommit, label, multiline = false, maxLength }: Props) {
  const [draft, setDraft] = useState(value);
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

  const common = {
    className: INPUT,
    'aria-label': label,
    value: draft,
    maxLength,
    onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
    onBlur: () => void commit(),
    onKeyDown,
  };
  return multiline ? <textarea rows={3} {...common} /> : <input type="text" {...common} />;
}
