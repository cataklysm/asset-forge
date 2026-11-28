import { useRef, useState, type FormEvent } from 'react';
import { call, describeError } from '../api';
import { Dialog } from '../components/Dialog';
import {
  CANCEL_LABEL,
  CREATE_PROJECT_LABEL,
  NEW_PROJECT_LABEL,
  PROJECT_DESCRIPTION_LABEL,
  PROJECT_NAME_LABEL,
} from '../labels';
import { ALERT, BUTTON, INPUT } from '../ui';

/** The props of `NewProjectDialog`. */
interface Props {
  open: boolean;
  /** Closes the dialog; the form is cleared first. */
  onClose(): void;
  /** Called with the id of the created project. */
  onCreated(id: string): void;
}

/**
 * Creates a project from a name and an optional description.
 *
 * @param props whether it is open, the close and the create callback
 * @returns the dialog
 */
export function NewProjectDialog({ open, onClose, onCreated }: Props) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const trimmed = name.trim();

  function close() {
    setName('');
    setDescription('');
    setError(null);
    onClose();
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    if (creating || trimmed === '') return;
    setCreating(true);
    setError(null);
    try {
      const text = description.trim();
      const project = await call('projects:create', { name: trimmed, ...(text !== '' && { description: text }) });
      setName('');
      setDescription('');
      onCreated(project.id);
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setCreating(false);
    }
  }

  return (
    <Dialog open={open} title={NEW_PROJECT_LABEL} initialFocusRef={nameRef} onClose={close}>
      <form className="space-y-3" onSubmit={(event) => void create(event)}>
        {error !== null && (
          <p role="alert" className={ALERT}>
            {error}
          </p>
        )}
        <input
          ref={nameRef}
          aria-label={PROJECT_NAME_LABEL}
          placeholder={PROJECT_NAME_LABEL}
          maxLength={200}
          className={`w-full ${INPUT}`}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <textarea
          aria-label={PROJECT_DESCRIPTION_LABEL}
          placeholder={PROJECT_DESCRIPTION_LABEL}
          maxLength={5000}
          rows={3}
          className={`h-auto w-full py-1.5 ${INPUT}`}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
        <div className="flex justify-end gap-2">
          <button type="button" className={BUTTON} onClick={close}>
            {CANCEL_LABEL}
          </button>
          <button type="submit" className={BUTTON} disabled={creating || trimmed === ''}>
            {CREATE_PROJECT_LABEL}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
