import type { KeyboardEvent } from 'react';
import { purposeOf, type ProviderPurpose } from '@assetforge/contracts';
import { NO_PROVIDER, PROVIDER_LABEL, PROVIDER_STATE_LABELS, providerOptionLabel } from '../labels';
import { providerStatus, useProviders } from '../provider-context';
import { SELECT } from '../ui';

interface Props {
  value: string | null;
  onChange(id: string | null): void;
  disabled?: boolean;
  /** An entry left out of the options, such as the source of a move. */
  exclude?: string | null;
  /** The purpose of the entries offered; `vision` (image analysis) unless given. */
  purpose?: ProviderPurpose;
}

/** The keys that open a native select. */
const OPENING_KEYS: ReadonlySet<string> = new Set([' ', 'Enter', 'F4']);

/**
 * The provider entries of `purpose` as a select, each option naming the entry's state. Opening it asks
 * every entry again; it preselects nothing itself, and a `value` that is not listed shows as no provider.
 */
export function ProviderSelect({ value, onChange, disabled = false, exclude = null, purpose = 'vision' }: Props) {
  const state = useProviders();
  const providers = (state.list?.providers ?? []).filter((p) => purposeOf(p.kind) === purpose && p.id !== exclude);
  const listed = value !== null && providers.some((p) => p.id === value);

  function onKeyDown(event: KeyboardEvent<HTMLSelectElement>) {
    if (OPENING_KEYS.has(event.key) || (event.altKey && event.key === 'ArrowDown')) state.checkAll();
  }

  return (
    <select
      className={`min-w-0 ${SELECT}`}
      aria-label={PROVIDER_LABEL}
      value={listed ? value : ''}
      disabled={disabled}
      aria-busy={state.loading || undefined}
      onMouseDown={() => state.checkAll()}
      onKeyDown={onKeyDown}
      onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
    >
      {!listed && <option value="">{NO_PROVIDER}</option>}
      {providers.map((p) => (
        <option key={p.id} value={p.id}>
          {providerOptionLabel(p.name, PROVIDER_STATE_LABELS[providerStatus(state, p.id)])}
        </option>
      ))}
    </select>
  );
}
