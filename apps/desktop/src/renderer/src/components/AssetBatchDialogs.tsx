import { FileRoleSchema, type FileRecord, type FileRole } from '@assetforge/contracts';
import { label } from '../labels';
import { sharedTags } from '../selection';
import { ALERT, BUTTON, SELECT } from '../ui';
import { Dialog } from './Dialog';
import { TagRow } from './TagRow';

// The dialogs of the asset Files tab's selection bar: Add tags and Set role.

const ROLES = FileRoleSchema.options;

/** The props of the Add tags dialog. */
interface AddTagsDialogProps {
  /** Whether the dialog is open. */
  open: boolean;
  /** The eligible selected files; their shared tags are shown. */
  files: readonly FileRecord[];
  /** Adds or removes a tag on all of them. */
  onChangeTag(channel: 'files:addTagMany' | 'files:removeTagMany', name: string): Promise<void>;
  /** Closes the dialog. */
  onClose(): void;
}

/**
 * Add tags: the tags all eligible selected files share, with add and remove.
 *
 * @param props whether it is open, the files, the change and the close action
 * @returns the dialog
 */
export function AddTagsDialog({ open, files, onChangeTag, onClose }: AddTagsDialogProps) {
  return (
    <Dialog open={open} title="Add tags" onClose={onClose}>
      <div className="space-y-4">
        <TagRow
          label="Image tags"
          kind="file"
          tags={sharedTags(files)}
          onAdd={(name) => onChangeTag('files:addTagMany', name)}
          onRemove={(name) => onChangeTag('files:removeTagMany', name)}
        />
        <div className="flex justify-end">
          <button type="button" className={BUTTON} onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/** The props of the Set role dialog. */
interface SetRoleDialogProps {
  /** Whether the dialog is open. */
  open: boolean;
  /** The chosen role. */
  role: FileRole;
  /** Chooses another role. */
  onRoleChange(role: FileRole): void;
  /** Whether a batch runs; disables Apply. */
  busy: boolean;
  /** The failure of the last Apply as a whole; null without one. */
  error: string | null;
  /** Sets the role on the eligible selected files. */
  onApply(): void;
  /** Closes the dialog. */
  onClose(): void;
}

/**
 * Set role: a role select with Apply and Cancel.
 *
 * @param props whether it is open, the role, whether a batch runs, the error and the actions
 * @returns the dialog
 */
export function SetRoleDialog({ open, role, onRoleChange, busy, error, onApply, onClose }: SetRoleDialogProps) {
  return (
    <Dialog open={open} title="Set role" onClose={onClose}>
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <select
            className={SELECT}
            aria-label="Role"
            value={role}
            onChange={(event) => onRoleChange(FileRoleSchema.parse(event.target.value))}
          >
            {ROLES.map((option) => (
              <option key={option} value={option}>
                {label(option)}
              </option>
            ))}
          </select>
          <button type="button" className={BUTTON} disabled={busy} onClick={onApply}>
            Apply
          </button>
          <button type="button" className={BUTTON} onClick={onClose}>
            Cancel
          </button>
        </div>
        {error !== null && (
          <p role="alert" className={ALERT}>
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
