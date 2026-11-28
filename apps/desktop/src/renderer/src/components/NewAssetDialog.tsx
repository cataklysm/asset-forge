import { useRef, useState, type FormEvent } from 'react';
import type { AssetType } from '@assetforge/contracts';
import { call, describeError } from '../api';
import { RETRY_LABEL } from '../labels';
import { ALERT, BUTTON, INPUT, SELECT } from '../ui';
import { Dialog } from './Dialog';

// The dialog that creates an asset.

interface Props {
  /** Shows the dialog. */
  open: boolean;
  /** The asset types to choose from; the first is preselected. */
  types: readonly AssetType[];
  /** The error of the last load of the types; null when it succeeded or still runs. */
  typesError: string | null;
  /** Loads the types again. */
  onRetryTypes(): void;
  /** Closes the dialog. */
  onClose(): void;
  /** Receives the new asset's ID. */
  onCreated(id: string): void;
}

/**
 * Creates an asset from a name and a type.
 *
 * @param props the open state, the types and the callbacks
 * @returns the dialog
 */
export function NewAssetDialog({ open, types, typesError, onRetryTypes, onClose, onCreated }: Props) {
  const [name, setName] = useState('');
  const [typeId, setTypeId] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const effectiveType = types.some((type) => type.id === typeId) ? typeId : (types[0]?.id ?? '');
  const trimmed = name.trim();

  /** Clears the form and closes the dialog. */
  function close() {
    setName('');
    setTypeId('');
    setError(null);
    onClose();
  }

  /** Creates the asset once at a time. */
  async function create(event: FormEvent) {
    event.preventDefault();
    if (creating || trimmed === '' || effectiveType === '') return;
    setCreating(true);
    setError(null);
    try {
      const asset = await call('assets:create', { name: trimmed, typeId: effectiveType });
      onCreated(asset.id);
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setCreating(false);
    }
  }

  return (
    <Dialog open={open} title="New asset" initialFocusRef={nameRef} onClose={close}>
      <form className="space-y-3" onSubmit={(event) => void create(event)}>
        {error !== null && (
          <p role="alert" className={ALERT}>
            {error}
          </p>
        )}
        <input
          ref={nameRef}
          aria-label="Asset name"
          placeholder="Asset name"
          maxLength={200}
          className={`w-full ${INPUT}`}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <select
          aria-label="Asset type"
          className={`w-full ${SELECT}`}
          value={effectiveType}
          onChange={(event) => setTypeId(event.target.value)}
        >
          {types.map((type) => (
            <option key={type.id} value={type.id}>
              {type.name}
            </option>
          ))}
        </select>
        {/* Without types nothing can be created: the failed load is named and can be repeated. */}
        {types.length === 0 && typesError !== null && (
          <div className="flex items-center gap-2">
            <p role="alert" className={`min-w-0 flex-1 ${ALERT}`}>
              {typesError}
            </p>
            <button type="button" className={BUTTON} onClick={onRetryTypes}>
              {RETRY_LABEL}
            </button>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className={BUTTON} onClick={close}>
            Cancel
          </button>
          <button type="submit" className={BUTTON} disabled={creating || trimmed === '' || effectiveType === ''}>
            Create
          </button>
        </div>
      </form>
    </Dialog>
  );
}
