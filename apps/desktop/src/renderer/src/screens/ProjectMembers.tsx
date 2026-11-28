import { ChevronDown, ChevronRight } from 'lucide-react';
import { Fragment } from 'react';
import type { ProjectMember } from '@assetforge/contracts';
import { AssignmentFields } from '../components/AssignmentFields';
import { Link } from '../components/Link';
import { label } from '../labels';
import { BORDER, BUTTON_INLINE, ICON_BUTTON_INLINE, MUTED } from '../ui';

/** The props of `MembersTable`. */
interface MembersTableProps {
  /** The members on the shown page. */
  items: readonly ProjectMember[];
  projectName: string;
  /** The name of an asset type by id. */
  typeName(typeId: string): string;
  /** The assets whose notes row is open. */
  expanded: ReadonlySet<string>;
  onToggleNotes(assetId: string): void;
  onOpenAsset(assetId: string): void;
  /** Reloads the members after an assignment changed. */
  onChanged(): void;
  onRemove(assetId: string): void;
}

/**
 * The table of project members.
 *
 * @param props the members, the project name, the open notes rows and the callbacks
 * @returns the table
 */
export function MembersTable(props: MembersTableProps) {
  const { items, projectName, typeName, expanded, onToggleNotes, onOpenAsset, onChanged, onRemove } = props;
  return (
    <table aria-label="Members" className="w-full text-left text-sm">
      <thead className={`border-b ${BORDER} ${MUTED}`}>
        <tr>
          <th className="py-2 pr-3 font-normal">Asset</th>
          <th className="py-2 pr-3 font-normal">Type</th>
          <th className="py-2 pr-3 font-normal">Status</th>
          <th className="py-2 pr-3 font-normal">Assignment</th>
          <th className="py-2 pr-3 font-normal">Notes</th>
          <th className="py-2 font-normal">
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {items.map((member) => (
          <MemberRows
            key={member.assetId}
            member={member}
            projectName={projectName}
            typeName={typeName(member.asset.typeId)}
            notesOpen={expanded.has(member.assetId)}
            onToggleNotes={() => onToggleNotes(member.assetId)}
            onOpenAsset={() => onOpenAsset(member.assetId)}
            onChanged={onChanged}
            onRemove={() => onRemove(member.assetId)}
          />
        ))}
      </tbody>
    </table>
  );
}

/** The props of `MemberRows`. */
interface MemberRowsProps {
  member: ProjectMember;
  projectName: string;
  typeName: string;
  /** Whether the notes row shows. */
  notesOpen: boolean;
  onToggleNotes(): void;
  onOpenAsset(): void;
  onChanged(): void;
  onRemove(): void;
}

/**
 * One member: its main row and, when expanded, a row with the assignment notes.
 *
 * @param props the member, its names, whether the notes show, and the callbacks
 * @returns one or two table rows
 */
function MemberRows({
  member,
  projectName,
  typeName,
  notesOpen,
  onToggleNotes,
  onOpenAsset,
  onChanged,
  onRemove,
}: MemberRowsProps) {
  const name = member.asset.name;
  const Chevron = notesOpen ? ChevronDown : ChevronRight;
  return (
    <Fragment>
      <tr className={notesOpen ? '' : `border-b ${BORDER}`}>
        <td className="py-2 pr-3">
          <Link onFollow={onOpenAsset}>{name}</Link>
        </td>
        <td className="py-2 pr-3">{typeName}</td>
        <td className="py-2 pr-3">{label(member.asset.status)}</td>
        <td className="py-2 pr-3">
          <AssignmentFields assignment={member} fields="main" onChanged={onChanged} />
        </td>
        <td className="py-2 pr-3">
          <button
            type="button"
            className={ICON_BUTTON_INLINE}
            aria-label={`Notes for ${name}`}
            aria-expanded={notesOpen}
            title={member.notes === '' ? 'Notes' : member.notes}
            onClick={onToggleNotes}
          >
            <Chevron size={16} aria-hidden />
          </button>
        </td>
        <td className="py-2 text-right">
          <button
            type="button"
            className={BUTTON_INLINE}
            aria-label={`Remove ${name} from ${projectName}`}
            title="Removes the assignment only; the asset and its files are kept"
            onClick={onRemove}
          >
            Remove
          </button>
        </td>
      </tr>
      {notesOpen && (
        <tr className={`border-b ${BORDER}`}>
          <td colSpan={6} className="pb-2">
            <AssignmentFields assignment={member} fields="notes" onChanged={onChanged} />
          </td>
        </tr>
      )}
    </Fragment>
  );
}
