import { normalizeTagPrefix, type TagSuggestion } from '@assetforge/contracts';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type Ref } from 'react';
import { call } from '../api';
import { latestOnly } from '../hooks/useLoad';
import { BORDER, INPUT } from '../ui';

interface Props {
  value: string;
  onValueChange(v: string): void;
  onCommit(text: string): void;
  placeholder: string;
  label: string;
  title?: string;
  inputRef?: Ref<HTMLInputElement>;
  /** Receives every key the combobox does not handle itself (including Esc while the list is closed). */
  onKeyDown?(e: KeyboardEvent<HTMLInputElement>): void;
  disabled?: boolean;
}

const SUGGESTION_LIMIT = 8;
const NONE: TagSuggestion[] = [];

/**
 * A tag input with suggestions (ARIA 1.2 combobox with a listbox popup). Enter commits the active
 * suggestion's display name, or the typed text when no suggestion is active.
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
}: Props) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<TagSuggestion[]>(NONE);
  const [active, setActive] = useState(-1);
  const track = useRef<ReturnType<typeof latestOnly<TagSuggestion[]>> | null>(null);
  track.current ??= latestOnly<TagSuggestion[]>();
  const prefix = normalizeTagPrefix(value);

  useEffect(() => {
    let mounted = true;
    if (!open || prefix === '') {
      // Supersedes a request still in flight.
      void track.current!(Promise.resolve(NONE));
      setSuggestions(NONE);
      setActive(-1);
      return;
    }
    void track.current!(call('tags:suggest', { prefix, limit: SUGGESTION_LIMIT })).then((result) => {
      if (!mounted || result.stale) return;
      // Suggestions are a convenience: a failed request just shows none.
      setSuggestions(result.value ?? NONE);
      setActive(-1);
    });
    return () => {
      mounted = false;
    };
  }, [open, prefix]);

  const expanded = open && suggestions.length > 0;
  const optionId = (index: number) => `${listId}-option-${index}`;

  function commit(text: string) {
    setOpen(false);
    onCommit(text);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!expanded) {
        setOpen(true);
        return;
      }
      const n = suggestions.length;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((current) => (current < 0 ? (step === 1 ? 0 : n - 1) : (current + step + n) % n));
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
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={expanded && active >= 0 ? optionId(active) : undefined}
        placeholder={placeholder}
        title={title}
        disabled={disabled}
        maxLength={200}
        value={value}
        onChange={(event) => {
          setOpen(true);
          onValueChange(event.target.value);
        }}
        onKeyDown={handleKeyDown}
        onBlur={() => setOpen(false)}
        className={`${INPUT} w-40`}
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
