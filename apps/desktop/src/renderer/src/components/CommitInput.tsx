import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
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

/** The refs and callbacks one commit of a `CommitInput` works with. */
interface CommitState {
  /** True while a save runs. */
  saving: MutableRefObject<boolean>;
  /** True when a commit was asked for while a save ran; it is made once that save settled. */
  pendingCommit: MutableRefObject<boolean>;
  /** The text saved last, until the reload hands in the new value. */
  committed: MutableRefObject<string | null>;
  /** The saved value the field received last. */
  previousValue: MutableRefObject<string>;
  /** The draft as typed last, also when the render with it has not happened yet. */
  latestDraft: MutableRefObject<string>;
  /** The commit callback of the field. */
  onCommit: Props['onCommit'];
  /** Sets the draft shown in the field. */
  setDraft: Dispatch<SetStateAction<string>>;
}

/**
 * Saves the latest draft when it differs from the saved value. A commit asked for while a save runs is made
 * once that save settled, with the draft typed by then, whether the save succeeded or failed.
 *
 * @param state the refs and callbacks of the field
 * @returns a promise that resolves when this commit and every commit it was asked to repeat are done
 */
async function commitDraft(state: CommitState): Promise<void> {
  const sent = state.latestDraft.current;
  if (sent === state.previousValue.current || sent === state.committed.current) return;
  if (state.saving.current) {
    state.pendingCommit.current = true;
    return;
  }
  state.saving.current = true;
  const isSaved = await sendDraft(state.onCommit, sent);
  state.saving.current = false;
  if (isSaved) state.committed.current = sent;
  else state.setDraft((current) => (current === sent ? state.previousValue.current : current));
  if (!state.pendingCommit.current) return;
  state.pendingCommit.current = false;
  if (state.latestDraft.current !== sent) await commitDraft(state);
}

/**
 * Hands one draft to the commit callback.
 *
 * @param onCommit the commit callback of the field
 * @param sent the draft to save
 * @returns a promise that resolves to false when the callback answered false or threw, otherwise true
 */
async function sendDraft(onCommit: Props['onCommit'], sent: string): Promise<boolean> {
  try {
    return (await onCommit(sent)) !== false;
  } catch {
    return false;
  }
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
  // Enter followed by blur must not save the same text twice, neither while the save runs nor after it
  // succeeded and before the reload hands in the new value.
  const saving = useRef(false);
  const pendingCommit = useRef(false);
  const committed = useRef<string | null>(null);
  const previousValue = useRef(value);
  const latestDraft = useRef(value);

  useEffect(() => {
    latestDraft.current = draft;
  }, [draft]);

  useEffect(() => {
    const previous = previousValue.current;
    const saved = committed.current;
    previousValue.current = value;
    committed.current = null;
    // A new value replaces only a draft the user has not changed since: text typed while the reload was in
    // flight stays.
    setDraft((current) => (current === previous || current === saved ? value : current));
  }, [value]);

  const state: CommitState = { saving, pendingCommit, committed, previousValue, latestDraft, onCommit, setDraft };

  /**
   * Commits on Enter, in a textarea only on Ctrl+Enter.
   *
   * @param event the key press
   */
  function onKeyDown(event: KeyboardEvent) {
    if (event.key !== 'Enter') return;
    if (multiline && !event.ctrlKey) return;
    event.preventDefault();
    void commitDraft(state);
  }

  const inline = variant === 'inline';
  const common = {
    className: `${inline ? INLINE : INPUT} ${className}`,
    'aria-label': label,
    value: draft,
    maxLength,
    placeholder,
    onChange: (event: { target: { value: string } }) => {
      latestDraft.current = event.target.value;
      setDraft(event.target.value);
    },
    onFocus: () => setFocused(true),
    onBlur: () => {
      setFocused(false);
      void commitDraft(state);
    },
    onKeyDown,
  };
  if (!multiline) return <input type="text" {...common} />;
  const rows = inline && !focused ? 1 : 3;
  return <textarea rows={rows} {...common} className={`${common.className} ${inline ? 'resize-none py-1.5' : ''}`} />;
}
