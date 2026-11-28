import { Folder } from 'lucide-react';
import type { WorkspaceSummary } from '@assetforge/contracts';
import { Menu } from '../components/Menu';
import { formatDateTime } from '../format';
import {
  OPEN_WORKSPACE_BUTTON,
  REMOVE_WORKSPACE_LABEL,
  REMOVE_WORKSPACE_TITLE,
  RESTORE_BACKUP_LABEL,
  RESTORE_BACKUP_TITLE,
  WORKSPACE_LAST_OPENED_COLUMN,
  WORKSPACE_LOCATION_COLUMN,
  WORKSPACE_NAME_COLUMN,
  openWorkspaceLabel,
  workspaceActionsLabel,
} from '../labels';
import { BORDER, BUTTON_INLINE, MUTED } from '../ui';

/** The props of `WorkspaceTable`. */
interface Props {
  /** The known workspaces, newest first, or null while loading. */
  sorted: WorkspaceSummary[] | null;
  busy: boolean;
  onOpen(workspace: WorkspaceSummary): void;
  onRemove(workspace: WorkspaceSummary): void;
  /** Opens the restore dialog for the workspace. */
  onRestore(workspace: WorkspaceSummary): void;
}

/** Selects the Open buttons of the rows, so the screen can move the focus to a neighbour after a removal. */
export const WORKSPACE_OPEN_SELECTOR = '[data-workspace-open]';

/**
 * The table of known workspaces, with three skeleton rows while the list loads.
 *
 * @param props the workspaces, the busy flag and the callbacks
 * @returns the table
 */
export function WorkspaceTable({ sorted, busy, ...callbacks }: Props) {
  const headerCell = `px-3 py-2 text-left text-sm font-normal ${MUTED}`;
  return (
    <table className={`w-full border-collapse rounded-control border ${BORDER}`}>
      <thead>
        <tr className={`border-b ${BORDER}`}>
          <th scope="col" className={headerCell}>
            {WORKSPACE_NAME_COLUMN}
          </th>
          <th scope="col" className={headerCell}>
            {WORKSPACE_LOCATION_COLUMN}
          </th>
          <th scope="col" className={headerCell}>
            {WORKSPACE_LAST_OPENED_COLUMN}
          </th>
          <th scope="col" className={headerCell}>
            <span className="sr-only" />
          </th>
        </tr>
      </thead>
      <tbody>
        {sorted === null
          ? [0, 1, 2].map((index) => <SkeletonRow key={index} />)
          : sorted.map((workspace) => (
              <WorkspaceRow key={workspace.id} workspace={workspace} busy={busy} {...callbacks} />
            ))}
      </tbody>
    </table>
  );
}

/**
 * A row of four pulsing cells.
 *
 * @returns the skeleton row
 */
function SkeletonRow() {
  return (
    <tr data-skeleton="" className={`border-b last:border-b-0 ${BORDER}`}>
      {[0, 1, 2, 3].map((cell) => (
        <td key={cell} className="px-3 py-3">
          <div className="h-4 animate-pulse rounded-control bg-raised" />
        </td>
      ))}
    </tr>
  );
}

/**
 * One workspace: name, location, last opened, Open and the Remove menu.
 *
 * @param props the workspace, the busy flag and the callbacks
 * @returns the row
 */
function WorkspaceRow({ workspace, ...actions }: { workspace: WorkspaceSummary } & Omit<Props, 'sorted'>) {
  return (
    <tr className={`border-b last:border-b-0 ${BORDER}`}>
      <td className="px-3 py-3">
        <span className="flex items-center gap-2 font-semibold">
          <Folder size={18} aria-hidden />
          {workspace.name}
        </span>
      </td>
      <td className={`max-w-0 truncate px-3 py-3 ${MUTED}`} title={workspace.rootPath}>
        {workspace.rootPath}
      </td>
      <td className={`whitespace-nowrap px-3 py-3 ${MUTED}`}>{formatDateTime(workspace.lastOpenedAt)}</td>
      <td className="px-3 py-2">
        <WorkspaceActions workspace={workspace} {...actions} />
      </td>
    </tr>
  );
}

/**
 * The Open button and the menu with Restore backup and Remove of one row.
 *
 * @param props the workspace, the busy flag and the callbacks
 * @returns the actions
 */
function WorkspaceActions({
  workspace,
  busy,
  onOpen,
  onRemove,
  onRestore,
}: { workspace: WorkspaceSummary } & Omit<Props, 'sorted'>) {
  return (
    <div className="flex items-center justify-end gap-2">
      <button
        type="button"
        className={BUTTON_INLINE}
        disabled={busy}
        aria-label={openWorkspaceLabel(workspace.name)}
        data-workspace-open=""
        onClick={() => onOpen(workspace)}
      >
        {OPEN_WORKSPACE_BUTTON}
      </button>
      <Menu
        label={workspaceActionsLabel(workspace.name)}
        items={[
          {
            label: RESTORE_BACKUP_LABEL,
            disabled: busy,
            title: RESTORE_BACKUP_TITLE,
            onSelect: () => onRestore(workspace),
          },
          {
            label: REMOVE_WORKSPACE_LABEL,
            disabled: busy,
            title: REMOVE_WORKSPACE_TITLE,
            onSelect: () => onRemove(workspace),
          },
        ]}
      />
    </div>
  );
}
