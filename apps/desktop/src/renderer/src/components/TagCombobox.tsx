import { normalizeTagPrefix } from '@assetforge/contracts';
import { useId, useState, type KeyboardEvent, type Ref } from 'react';
import { useTagSuggestions } from '../hooks/useTagSuggestions';
import { BORDER, INLINE_INPUT, INPUT } from '../ui';

/** The props of `TagCombobox`. */
interface Props {
  /** The typed text. */
  value: string;
  /** Called with every change of the text. */
  onValueChange(value: string): void;
  /** Called with the text to add: the active suggestion's display name, or the typed text. */
  onCommit(text: string): void;
  /** The placeholder. */
  placeholder: string;
  /** The accessible name of the input and the list. */
  label: string;
  /** The tooltip. */
  title?: string;
  /** Receives the input element. */
  inputRef?: Ref<HTMLInputElement>;
  /** Receives every key the combobox does not handle itself (including Esc while the list is closed). */
  onKeyDown?(event: KeyboardEvent<HTMLInputElement>): void;
  /** Disables the input. */
  disabled?: boolean;
  /** Keeps the input focusable but refuses typing (for a full filter, so the focus is not lost). */
  readOnly?: boolean;
  /** `box` (the default) is a bordered input; `inline` reads as an action in a row of chips. */
  look?: 'box' | 'inline';
}

/**
 * The active index after ↑/↓, wrapping; from none ↓ starts at the first and ↑ at the last.
 *
 * @param current the active index, or -1
 * @param step the direction
 * @param count the number of suggestions
 * @returns the new active index
 */
function stepActive(current: number, step: 1 | -1, count: number): number {
  if (current < 0) return step === 1 ? 0 : count - 1;
  return (current + step + count) % count;
}

/**
 * A tag input with suggestions (ARIA 1.2 combobox with a listbox popup). Enter commits the active
 * suggestion's display name, or the typed text when no suggestion is active.
 *
 * @param props the text, its callbacks, the label, the look and the input ref
 * @returns the input and, while there are suggestions, the list
 */
export function TagCombobox({
  value,
  onValueChange,
  onCommit,
  placeholder,
  label,
  title,
  inputRef,
  onKeyDown,
  disabled = false,
  readOnly = false,
  look = 'box',
}: Props) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const { suggestions, active, setActive } = useTagSuggestions(open, normalizeTagPrefix(value));

  const expanded = open && suggestions.length > 0;
  const optionId = (index: number) => `${listId}-option-${index}`;

  function commit(text: string) {
    setOpen(false);
    onCommit(text);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    // Keys that pick or confirm characters of an input method (IME) belong to that method.
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!expanded) {
        setOpen(true);
        return;
      }
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((current) => stepActive(current, step, suggestions.length));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const suggestion = expanded && active >= 0 ? suggestions[active] : undefined;
      commit(suggestion?.displayName ?? value);
      return;
    }
    if (event.key === 'Escape' && expanded) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      return;
    }
    onKeyDown?.(event);
  }

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-label={label}
        aria-expanded={expanded}
        aria-controls={expanded ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={expanded && active >= 0 ? optionId(active) : undefined}
        placeholder={placeholder}
        title={title}
        disabled={disabled}
        readOnly={readOnly}
        // A read-only input takes no text, so it looks like a disabled one while keeping the focus.
        aria-disabled={readOnly || undefined}
        maxLength={200}
        value={value}
        onChange={(event) => {
          setOpen(true);
          onValueChange(event.target.value);
        }}
        onKeyDown={handleKeyDown}
        onBlur={() => setOpen(false)}
        className={`${look === 'inline' ? INLINE_INPUT : `${INPUT} w-40`} aria-disabled:opacity-50`}
      />
      {expanded && (
        <ul
          id={listId}
          role="listbox"
          aria-label={label}
          className={`absolute left-0 top-full z-50 mt-1 max-h-64 min-w-full overflow-auto rounded-control border bg-surface py-1 ${BORDER}`}
        >
          {suggestions.map((suggestion, index) => (
            <li
              key={suggestion.name}
              id={optionId(index)}
              role="option"
              aria-selected={index === active}
              // Keeps focus in the input.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => commit(suggestion.displayName)}
              className={`cursor-default whitespace-nowrap px-2.5 py-1.5 text-sm text-text hover:bg-raised ${
                index === active ? 'bg-nav-active' : ''
              }`}
            >
              {suggestion.displayName}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
