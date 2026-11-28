import { useRef, useState } from 'react';
import { FileRoleSchema, type FileRecord, type FileRole } from '@assetforge/contracts';
import { call, describeError } from '../api';
import { label } from '../labels';
import { ALERT, BUTTON, SELECT } from '../ui';
import { AssetPicker } from './AssetPicker';

// The role select of an asset's file and the assign control of an inbox file.

/** Every file role, in the order of the schema. */
const ROLES = FileRoleSchema.options;

/**
 * One option per file role.
 *
 * @returns the options
 */
function roleOptions() {
  return ROLES.map((option) => (
    <option key={option} value={option}>
      {label(option)}
    </option>
  ));
}

/**
 * The role select of a file that belongs to an asset; a change goes through `files:assign`.
 *
 * @param props the file, the change callback and the width
 * @returns the select and its error
 */
export function FileRoleSelect({
  file,
  onChanged,
  fullWidth = false,
}: {
  /** The file. */
  file: FileRecord;
  /** Receives the file with its new role. */
  onChanged(file: FileRecord): void;
  /** Stretches the select to the width of its container. */
  fullWidth?: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Synchronous guard: a second activation before the re-render must not send a second request.
  const busyRef = useRef(false);

  /** Assigns the file again with another role. */
  async function change(role: FileRole) {
    if (busyRef.current || file.assetId === null) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      onChanged(await call('files:assign', { fileId: file.id, assetId: file.assetId, role }));
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <select
        className={fullWidth ? `${SELECT} w-full` : SELECT}
        disabled={busy}
        aria-label={`Role of ${file.originalName}`}
        value={file.role ?? 'other'}
        onChange={(event) => void change(FileRoleSchema.parse(event.target.value))}
      >
        {roleOptions()}
      </select>
      {error !== null && (
        <p role="alert" className={ALERT}>
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * The assign control of an inbox file: role and asset picker behind one "Assign" button.
 *
 * @param props the file, the assigned callback and the width
 * @returns the control; nothing for a file that is not complete
 */
export function AssignFileControl({
  file,
  onAssigned,
  fullWidth = false,
}: {
  /** The inbox file. */
  file: FileRecord;
  /** Called once the file belongs to an asset. */
  onAssigned(): void;
  /** Stretches the button, the select and the asset search to the width of their container. */
  fullWidth?: boolean;
}) {
  const width = fullWidth ? 'w-full' : '';
  const [assigning, setAssigning] = useState(false);
  const [role, setRole] = useState<FileRole>('reference');
  const [error, setError] = useState<string | null>(null);
  // The file has left the inbox: a later pick before the list has dropped the file sends nothing. (The picker
  // itself ignores a pick while the previous one runs.)
  const assignedRef = useRef<string | null>(null);

  /** Assigns the file to the picked asset with the chosen role, once per file. */
  async function assign(assetId: string) {
    if (assignedRef.current === file.id) return;
    setError(null);
    try {
      await call('files:assign', { fileId: file.id, assetId, role });
      assignedRef.current = file.id;
      onAssigned();
    } catch (caught) {
      setError(describeError(caught));
    }
  }

  if (file.status !== 'complete') return null;
  return (
    <div className="space-y-2">
      {assigning ? (
        <>
          <select
            className={`${SELECT} ${width}`}
            aria-label="Role"
            value={role}
            onChange={(event) => setRole(FileRoleSchema.parse(event.target.value))}
          >
            {roleOptions()}
          </select>
          <AssetPicker fullWidth={fullWidth} onPick={(asset) => assign(asset.id)} />
        </>
      ) : (
        <button type="button" className={`${BUTTON} ${width}`} onClick={() => setAssigning(true)}>
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
