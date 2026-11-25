import { useState } from 'react';
import {
  ApprovalStatusSchema,
  AssignmentPrioritySchema,
  type ProjectAssignment,
} from '@assetforge/contracts';
import { call, describeError } from '../api';
import { label } from '../labels';
import { ALERT, INPUT } from '../ui';
import { CommitInput } from './CommitInput';

type Patch = Parameters<typeof call<'assignments:update'>>[1]['patch'];

interface Props {
  assignment: ProjectAssignment;
  onChanged(next: ProjectAssignment): void;
}

/** Priority, approval status, intended use and notes of one assignment; saves each change through assignments:update. */
export function AssignmentFields({ assignment, onChanged }: Props) {
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
    } catch (e) {
      setError(describeError(e));
      return false;
    }
  }

  return (
    <div className="flex flex-wrap items-start gap-2">
      <select
        className={INPUT}
        aria-label="Priority"
        value={assignment.priority}
        onChange={(e) => void save({ priority: AssignmentPrioritySchema.parse(e.target.value) })}
      >
        {AssignmentPrioritySchema.options.map((p) => (
          <option key={p} value={p}>
            {label(p)}
          </option>
        ))}
      </select>
      <select
        className={INPUT}
        aria-label="Approval"
        value={assignment.approvalStatus}
        onChange={(e) => void save({ approvalStatus: ApprovalStatusSchema.parse(e.target.value) })}
      >
        {ApprovalStatusSchema.options.map((p) => (
          <option key={p} value={p}>
            {label(p)}
          </option>
        ))}
      </select>
      <CommitInput
        label="Intended use"
        value={assignment.intendedUse}
        maxLength={500}
        onCommit={(intendedUse) => save({ intendedUse })}
      />
      <CommitInput
        label="Notes"
        multiline
        value={assignment.notes}
        maxLength={5000}
        onCommit={(notes) => save({ notes })}
      />
      {error !== null && (
        <p role="alert" className={ALERT}>
          {error}
        </p>
      )}
    </div>
  );
}
