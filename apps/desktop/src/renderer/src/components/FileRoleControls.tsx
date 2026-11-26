import { useRef, useState } from 'react';
import { FileRoleSchema, type FileRecord, type FileRole } from '@assetforge/contracts';
import { call, describeError } from '../api';
import { label } from '../labels';
import { ALERT, BUTTON, INPUT } from '../ui';
import { AssetPicker } from './AssetPicker';

const ROLES = FileRoleSchema.options;

/** The role select of a file that belongs to an asset; a change goes through `files:assign`. */
export function FileRoleSelect({ file, onChanged }: { file: FileRecord; onChanged(file: FileRecord): void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Synchronous guard: a second activation before the re-render must not send a second request.
  const busyRef = useRef(false);

  async function change(role: FileRole) {
    if (busyRef.current || file.assetId === null) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      onChanged(await call('files:assign', { fileId: file.id, assetId: file.assetId, role }));
    } catch (e) {
      setError(describeError(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <select
        className={INPUT}
        disabled={busy}
        aria-label={`Role of ${file.originalName}`}
        value={file.role ?? 'other'}
        onChange={(e) => void change(FileRoleSchema.parse(e.target.value))}
      >
        {ROLES.map((r) => (
          <option key={r} value={r}>
            {label(r)}
          </option>
        ))}
      </select>
      {error !== null && (
        <p role="alert" className={ALERT}>
          {error}
        </p>
      )}
    </div>
  );
}

/** The assign control of an inbox file: role and asset picker behind one "Assign" button. */
export function AssignFileControl({ file, onAssigned }: { file: FileRecord; onAssigned(): void }) {
  const [assigning, setAssigning] = useState(false);
  const [role, setRole] = useState<FileRole>('reference');
  const [error, setError] = useState<string | null>(null);

  async function assign(assetId: string) {
    setError(null);
    try {
      await call('files:assign', { fileId: file.id, assetId, role });
      onAssigned();
    } catch (e) {
      setError(describeError(e));
    }
  }

  if (file.status !== 'complete') return null;
  return (
    <div className="space-y-2">
      {assigning ? (
        <>
          <select
            className={INPUT}
            aria-label="Role"
            value={role}
            onChange={(e) => setRole(FileRoleSchema.parse(e.target.value))}
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {label(r)}
              </option>
            ))}
          </select>
          <AssetPicker onPick={(asset) => assign(asset.id)} />
        </>
      ) : (
        <button type="button" className={BUTTON} onClick={() => setAssigning(true)}>
          Assign
        </button>
      )}
      {error !== null && (
        <p role="alert" className={ALERT}>
          {error}
        </p>
      )}
    </div>
  );
}
