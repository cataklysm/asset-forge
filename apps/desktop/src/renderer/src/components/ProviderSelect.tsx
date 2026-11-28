import type { KeyboardEvent } from 'react';
import { purposeOf, type ProviderPurpose } from '@assetforge/contracts';
import { NO_PROVIDER, PAUSED_TITLE, PROVIDER_LABEL, PROVIDER_STATE_LABELS, providerOptionLabel } from '../labels';
import { providerStatus, useProviders } from '../provider-context';
import { SELECT } from '../ui';

/** The props of `ProviderSelect`. */
interface Props {
  value: string | null;
  onChange(id: string | null): void;
  disabled?: boolean;
  /** An entry left out of the options, such as the source of a move. */
  exclude?: string | null;
  /** The purpose of the entries offered; `vision` (image analysis) unless given. */
  purpose?: ProviderPurpose;
  /** Entries whose job queue is paused: their option, and the select while one is chosen, say so in the tooltip. */
  pausedIds?: ReadonlySet<string>;
}

/** No entry is paused. */
const NONE_PAUSED: ReadonlySet<string> = new Set();

/** The keys that open a native select. */
const OPENING_KEYS: ReadonlySet<string> = new Set([' ', 'Enter', 'F4']);

/**
 * The provider entries of `purpose` as a select, each option naming the entry's state. Opening it asks
 * every entry again; it preselects nothing itself, and a `value` that is not listed shows as no provider.
 *
 * @param props the selected entry, its setter and which entries are offered
 */
export function ProviderSelect({
  value,
  onChange,
  disabled = false,
  exclude = null,
  purpose = 'vision',
  pausedIds = NONE_PAUSED,
}: Props) {
  const state = useProviders();
  const providers = (state.list?.providers ?? []).filter(
    (entry) => purposeOf(entry.kind) === purpose && entry.id !== exclude,
  );
  const listed = value !== null && providers.some((entry) => entry.id === value);

  /**
   * Asks every entry again when a key opens the select.
   *
   * @param event the key press
   */
  function onKeyDown(event: KeyboardEvent<HTMLSelectElement>) {
    if (OPENING_KEYS.has(event.key) || (event.altKey && event.key === 'ArrowDown')) state.checkAll();
  }

  return (
    <select
      className={`min-w-0 ${SELECT}`}
      aria-label={PROVIDER_LABEL}
      value={listed ? value : ''}
      title={listed && pausedIds.has(value) ? PAUSED_TITLE : undefined}
      disabled={disabled}
      aria-busy={state.loading || undefined}
      onMouseDown={() => state.checkAll()}
      onKeyDown={onKeyDown}
      onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
    >
      {!listed && <option value="">{NO_PROVIDER}</option>}
      {providers.map((entry) => (
        <option key={entry.id} value={entry.id} title={pausedIds.has(entry.id) ? PAUSED_TITLE : undefined}>
          {providerOptionLabel(entry.name, PROVIDER_STATE_LABELS[providerStatus(state, entry.id)])}
        </option>
      ))}
    </select>
  );
}
