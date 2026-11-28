import { useState } from 'react';
import { ApprovalStatusSchema, AssignmentPrioritySchema, type ProjectAssignment } from '@assetforge/contracts';
import { call, describeError } from '../api';
import { label } from '../labels';
import { ALERT, SELECT } from '../ui';
import { CommitInput } from './CommitInput';

/** The fields `assignments:update` takes. */
type Patch = Parameters<typeof call<'assignments:update'>>[1]['patch'];

/** The props of `AssignmentFields`. */
interface Props {
  assignment: ProjectAssignment;
  /** Called with the assignment a save answered. */
  onChanged(next: ProjectAssignment): void;
  /** `main` leaves the notes out, `notes` shows only them (e.g. in an expandable table row). */
  fields?: 'all' | 'main' | 'notes';
}

/**
 * Priority, approval status, intended use and notes of one assignment; saves each change through assignments:update.
 *
 * @param props the assignment, the change callback and which fields show
 * @returns the fields with their error line
 */
export function AssignmentFields({ assignment, onChanged, fields = 'all' }: Props) {
  const [error, setError] = useState<string | null>(null);

  async function save(patch: Patch): Promise<boolean> {
    setError(null);
    try {
      const next = await call('assignments:update', {
        projectId: assignment.projectId,
        assetId: assignment.assetId,
        patch,
      });
      onChanged(next);
      return true;
    } catch (failure) {
      setError(describeError(failure));
      return false;
    }
  }

  return (
    <div className="flex flex-wrap items-start gap-2">
      {fields !== 'notes' && (
        <>
          <select
            className={SELECT}
            aria-label="Priority"
            value={assignment.priority}
            onChange={(event) => void save({ priority: AssignmentPrioritySchema.parse(event.target.value) })}
          >
            {AssignmentPrioritySchema.options.map((priority) => (
              <option key={priority} value={priority}>
                {label(priority)}
              </option>
            ))}
          </select>
          <select
            className={SELECT}
            aria-label="Approval"
            value={assignment.approvalStatus}
            onChange={(event) => void save({ approvalStatus: ApprovalStatusSchema.parse(event.target.value) })}
          >
            {ApprovalStatusSchema.options.map((status) => (
              <option key={status} value={status}>
                {label(status)}
              </option>
            ))}
          </select>
          <CommitInput
            label="Intended use"
            variant="inline"
            placeholder="Intended use"
            className="h-9"
            value={assignment.intendedUse}
            maxLength={500}
            onCommit={(intendedUse) => save({ intendedUse })}
          />
        </>
      )}
      {fields !== 'main' && (
        <CommitInput
          label="Notes"
          multiline
          variant="inline"
          placeholder="Notes"
          className="min-w-64 flex-1"
          value={assignment.notes}
          maxLength={5000}
          onCommit={(notes) => save({ notes })}
        />
      )}
      {error !== null && (
        <p role="alert" className={`w-full ${ALERT}`}>
          {error}
        </p>
      )}
    </div>
  );
}
