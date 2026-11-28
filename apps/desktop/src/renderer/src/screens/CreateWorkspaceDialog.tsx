import type { FormEvent, RefObject } from 'react';
import { Dialog } from '../components/Dialog';
import { ALERT, BUTTON, INPUT, MUTED } from '../ui';

/** The props of `CreateWorkspaceDialog`. */
interface Props {
  open: boolean;
  /** The name input; the dialog focuses it. */
  nameRef: RefObject<HTMLInputElement | null>;
  /** The message of the last failed action. */
  error: string | null;
  name: string;
  setName(name: string): void;
  /** The chosen location, or null. */
  parentPath: string | null;
  /** The previewed workspace directory, or null. */
  targetPath: string | null;
  busy: boolean;
  /** Whether the trimmed name is empty. */
  nameEmpty: boolean;
  /** Enter in the name field: first pick the location, then create. */
  onSubmit(event: FormEvent): void;
  onChooseParent(): void;
  onCancel(): void;
}

/**
 * The New workspace dialog: name, location and the directory it will create.
 *
 * @param props the form values, the busy flag and the callbacks
 * @returns the dialog
 */
export function CreateWorkspaceDialog(props: Props) {
  const { open, nameRef, error, name, setName, parentPath, targetPath, busy, nameEmpty } = props;
  return (
    <Dialog open={open} title="New workspace" initialFocusRef={nameRef} onClose={props.onCancel}>
      <form className="space-y-3" onSubmit={props.onSubmit}>
        {error !== null && (
          <p role="alert" className={ALERT}>
            {error}
          </p>
        )}
        <input
          ref={nameRef}
          autoFocus
          aria-label="Workspace name"
          aria-describedby={parentPath === null ? undefined : 'create-location'}
          placeholder="Workspace name"
          maxLength={200}
          className={`w-full ${INPUT}`}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            className={BUTTON}
            disabled={busy}
            title="A folder named after the workspace is created inside the chosen location"
            onClick={props.onChooseParent}
          >
            {parentPath === null ? 'Choose location' : 'Change location'}
          </button>
        </div>
        {/* Only the path itself; explanations live in tooltips, not in the layout. */}
        {parentPath !== null && (
          <p
            id="create-location"
            title="Folder the workspace will be created in"
            className={`text-sm break-all ${MUTED}`}
          >
            {targetPath ?? parentPath}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className={BUTTON} onClick={props.onCancel}>
            Cancel
          </button>
          {/* Stays enabled without a location, so Enter in the name field opens the picker. */}
          <button type="submit" className={BUTTON} disabled={busy || nameEmpty}>
            Create
          </button>
        </div>
      </form>
    </Dialog>
  );
}
