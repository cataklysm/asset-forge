import { normalizeTagName } from '@assetforge/contracts';
import { useEffect, useRef, useState } from 'react';
import { INVALID_TAG, TAG_FILTER_LABEL, tagFilterFullTitle } from '../labels';
import type { TagLabels } from '../tag-rename';
import { ALERT } from '../ui';
import { TagChip } from './TagChip';
import { TagCombobox } from './TagCombobox';

/** The props of `TagFilter`. */
interface Props {
  /** The normalised tag names of the filter. */
  value: readonly string[];
  /** The display names of `value` by normalised name; a name without one shows as it is. */
  labels?: TagLabels;
  /** Called with the new names and their display names. */
  onChange(names: string[], labels: TagLabels): void;
  /** The tooltip of the input while it takes more names. */
  title?: string;
}

/** The most names one filter takes. */
const MAX_FILTER_TAGS = 10;

/** No display names. */
const NO_LABELS: TagLabels = {};

/**
 * The display names kept for `names` only.
 *
 * @param labels the display names
 * @param names the names that stay
 * @returns the labels of `names`
 */
function labelsFor(labels: TagLabels, names: readonly string[]): TagLabels {
  return Object.fromEntries(names.filter((name) => name in labels).map((name) => [name, labels[name]!]));
}

/**
 * A tag combobox that adds normalised tag names to a filter, with a removable chip per name showing the display
 * name it was chosen with.
 *
 * @param props the names, their display names, the change callback and the tooltip
 * @returns the input and the chips
 */
export function TagFilter({ value, labels = NO_LABELS, onChange, title }: Props) {
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
    if (value.includes(name)) return;
    const names = [...value, name];
    onChange(names, { ...labelsFor(labels, value), [name]: raw.trim() });
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
          placeholder={TAG_FILTER_LABEL}
          label={TAG_FILTER_LABEL}
          title={full ? tagFilterFullTitle(MAX_FILTER_TAGS) : title}
          inputRef={input}
          // Read-only rather than disabled, so the input adding the tenth tag keeps the focus.
          readOnly={full}
        />
        {value.map((name) => (
          <TagChip
            key={name}
            tag={{ name, displayName: labels[name] ?? name }}
            filter
            onRemove={() => {
              focusInput.current = true;
              const names = value.filter((other) => other !== name);
              onChange(names, labelsFor(labels, names));
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
