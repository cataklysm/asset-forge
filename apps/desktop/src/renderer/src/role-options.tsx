import { FileRoleSchema } from '@assetforge/contracts';
import { label } from './labels';

// The file roles every role select and role filter offers.

/** Every file role, in the order of the schema. */
export const ROLES = FileRoleSchema.options;

/**
 * One option per file role, labelled with its display text.
 *
 * @returns the options
 */
export function roleOptions() {
  return ROLES.map((option) => (
    <option key={option} value={option}>
      {label(option)}
    </option>
  ));
}
