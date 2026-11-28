import { Search } from 'lucide-react';
import { INPUT } from '../ui';

/** The props of `SearchField`. */
interface Props {
  /** The search text. */
  value: string;
  /** Called with every change; with '' when Esc clears it. */
  onChange(value: string): void;
  /** The placeholder. */
  placeholder: string;
  /** The accessible name. */
  label: string;
}

/**
 * A controlled search input; Esc with text clears it. Debouncing is the caller's job.
 *
 * @param props the text, the change callback, the placeholder and the label
 * @returns the field
 */
export function SearchField({ value, onChange, placeholder, label }: Props) {
  return (
    <div className="relative">
      <Search
        size={16}
        aria-hidden
        className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted"
      />
      <input
        type="search"
        data-search-field=""
        aria-label={label}
        placeholder={placeholder}
        title="Ctrl+F"
        maxLength={200}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || value === '') return;
          event.preventDefault();
          event.stopPropagation();
          onChange('');
        }}
        className={`${INPUT} w-64 pl-8`}
      />
    </div>
  );
}
