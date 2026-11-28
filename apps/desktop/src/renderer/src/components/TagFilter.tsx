import { normalizeTagName } from '@assetforge/contracts';
import { useEffect, useRef, useState } from 'react';
import { ALERT } from '../ui';
import { TagChip } from './TagChip';
import { TagCombobox } from './TagCombobox';
import { INVALID_TAG } from './TagRow';

/** The props of `TagFilter`. */
interface Props {
  /** The normalised tag names of the filter. */
  value: readonly string[];
  /** Called with the new names. */
  onChange(names: string[]): void;
  /** The tooltip of the input while it takes more names. */
  title?: string;
}

/** The most names one filter takes. */
const MAX_FILTER_TAGS = 10;

/**
 * A tag combobox that adds normalised tag names to a filter, with a removable chip per name.
 *
 * @param props the names, the change callback and the tooltip
 * @returns the input and the chips
 */
export function TagFilter({ value, onChange, title }: Props) {
  const [text, setText] = useState('');
  const [invalid, setInvalid] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // After a chip is removed, focus goes to the input.
  const focusInput = useRef(false);
  const full = value.length >= MAX_FILTER_TAGS;

  useEffect(() => {
    if (!focusInput.current) return;
    focusInput.current = false;
    input.current?.focus();
  }, [value]);

  function add(raw: string) {
    if (raw.trim() === '' || full) return;
    const name = normalizeTagName(raw);
    if (name === null) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setText('');
    if (!value.includes(name)) onChange([...value, name]);
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5">
        <TagCombobox
          value={text}
          onValueChange={(next) => {
            setText(next);
            setInvalid(false);
          }}
          onCommit={add}
          placeholder="Tags"
          label="Tags"
          title={full ? `At most ${MAX_FILTER_TAGS} tags` : title}
          inputRef={input}
          // Read-only rather than disabled, so the input adding the tenth tag keeps the focus.
          readOnly={full}
        />
        {value.map((name) => (
          <TagChip
            key={name}
            tag={{ name, displayName: name }}
            filter
            onRemove={() => {
              focusInput.current = true;
              onChange(value.filter((other) => other !== name));
            }}
          />
        ))}
      </div>
      {invalid && (
        <p role="alert" className={`mt-2 ${ALERT}`}>
          {INVALID_TAG}
        </p>
      )}
    </div>
  );
}
