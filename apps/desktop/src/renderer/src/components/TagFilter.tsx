import { normalizeTagName } from '@assetforge/contracts';
import { useEffect, useRef, useState } from 'react';
import { TagChip } from './TagChip';
import { TagCombobox } from './TagCombobox';

interface Props {
  value: readonly string[];
  onChange(names: string[]): void;
  title?: string;
}

const MAX_FILTER_TAGS = 10;

/** A tag combobox that adds normalised tag names to a filter, with a removable chip per name. */
export function TagFilter({ value, onChange, title }: Props) {
  const [text, setText] = useState('');
  const input = useRef<HTMLInputElement>(null);
  // After a chip is removed, focus goes to the input once it is enabled again.
  const focusInput = useRef(false);
  const full = value.length >= MAX_FILTER_TAGS;

  useEffect(() => {
    if (!focusInput.current) return;
    focusInput.current = false;
    input.current?.focus();
  }, [value]);

  function add(raw: string) {
    const name = normalizeTagName(raw);
    if (name === null) return;
    setText('');
    if (!value.includes(name)) onChange([...value, name]);
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <TagCombobox
        value={text}
        onValueChange={setText}
        onCommit={add}
        placeholder="Tags"
        label="Tags"
        title={full ? `At most ${MAX_FILTER_TAGS} tags` : title}
        inputRef={input}
        disabled={full}
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
  );
}
