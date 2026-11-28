import type { FormEvent, RefObject } from 'react';
import { Dialog } from '../components/Dialog';
import {
  CANCEL_LABEL,
  CHANGE_LOCATION_LABEL,
  CHOOSE_LOCATION_LABEL,
  CHOOSE_LOCATION_TITLE,
  CREATE_LOCATION_TITLE,
  CREATE_WORKSPACE_LABEL,
  NEW_WORKSPACE_LABEL,
  WORKSPACE_NAME_LABEL,
} from '../labels';
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
    <Dialog open={open} title={NEW_WORKSPACE_LABEL} initialFocusRef={nameRef} onClose={props.onCancel}>
      <form className="space-y-3" onSubmit={props.onSubmit}>
        {error !== null && (
          <p role="alert" className={ALERT}>
            {error}
          </p>
        )}
        <input
          ref={nameRef}
          autoFocus
          aria-label={WORKSPACE_NAME_LABEL}
          aria-describedby={parentPath === null ? undefined : 'create-location'}
          placeholder={WORKSPACE_NAME_LABEL}
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
            title={CHOOSE_LOCATION_TITLE}
            onClick={props.onChooseParent}
          >
            {parentPath === null ? CHOOSE_LOCATION_LABEL : CHANGE_LOCATION_LABEL}
          </button>
        </div>
        {/* Only the path itself; explanations live in tooltips, not in the layout. */}
        {parentPath !== null && (
          <p id="create-location" title={CREATE_LOCATION_TITLE} className={`text-sm break-all ${MUTED}`}>
            {targetPath ?? parentPath}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className={BUTTON} onClick={props.onCancel}>
            {CANCEL_LABEL}
          </button>
          {/* Stays enabled without a location, so Enter in the name field opens the picker. */}
          <button type="submit" className={BUTTON} disabled={busy || nameEmpty}>
            {CREATE_WORKSPACE_LABEL}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
