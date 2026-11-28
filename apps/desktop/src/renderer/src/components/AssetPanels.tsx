import { useState } from 'react';
import { RelationKindSchema, type AssetDetail, type RelationKind } from '@assetforge/contracts';
import { call } from '../api';
import { attempt } from '../attempt';
import { distinct } from '../format';
import { ADD_TO_PROJECT_LABEL, relationLabel } from '../labels';
import { ALERT, BORDER, BUTTON, MUTED, SELECT } from '../ui';
import { AssetPicker } from './AssetPicker';
import { AssignmentFields } from './AssignmentFields';
import { Link } from './Link';
import { ProjectPicker } from './ProjectPicker';

// The Projects and Relations tabs of the asset screen.

/** The tooltip of a link that is disabled while an import runs. */
export const IMPORT_BUSY = 'Import in progress';

/** A list the asset screen loads and hands to a panel. */
export type Loaded<T> = { data: T | null; error: string | null; reload(): void };

/** The props of the Projects tab. */
interface ProjectsPanelProps {
  /** The shown asset. */
  asset: AssetDetail;
  /** Its assignments, loaded by the screen (the tab count uses them too). */
  assignments: Loaded<Awaited<ReturnType<typeof call<'assignments:listByAsset'>>>>;
  /** Disables the project links while an import runs. */
  disabled: boolean;
  /** Opens a project. */
  onOpenProject(id: string): void;
}

/**
 * The projects the asset is assigned to, with their project-specific fields, Remove, and Add to project.
 *
 * @param props the asset, its assignments, whether the links are disabled and the open action
 * @returns the panel
 */
export function ProjectsPanel({ asset, assignments, disabled, onOpenProject }: ProjectsPanelProps) {
  const [error, setError] = useState<string | null>(null);
  const assigned = assignments.data ?? [];
  const assignedIds = assigned.map((assignment) => assignment.projectId);
  const errors = [error, assignments.error].filter((message): message is string => message !== null);

  return (
    <div className="space-y-3 pt-4">
      {distinct(errors).map((message) => (
        <p key={message} role="alert" className={ALERT}>
          {message}
        </p>
      ))}
      {assignments.data !== null && assigned.length === 0 && <p className={MUTED}>Not assigned to any project</p>}
      <ul className="space-y-2">
        {assigned.map((assignment) => (
          <li key={assignment.projectId} className={`space-y-2 border-b pb-2 ${BORDER}`}>
            <div className="flex items-center gap-2">
              <Link
                onFollow={() => onOpenProject(assignment.projectId)}
                disabled={disabled}
                title={disabled ? IMPORT_BUSY : undefined}
              >
                {assignment.project.name}
              </Link>
              <button
                type="button"
                className={BUTTON}
                aria-label={`Remove ${asset.name} from ${assignment.project.name}`}
                title="Removes the assignment only; the asset and its files are kept"
                onClick={() =>
                  void attempt(setError, async () => {
                    await call('assignments:remove', { projectId: assignment.projectId, assetId: asset.id });
                    assignments.reload();
                  })
                }
              >
                Remove
              </button>
            </div>
            <AssignmentFields assignment={assignment} onChanged={() => assignments.reload()} />
          </li>
        ))}
      </ul>
      <div className="max-w-sm">
        <ProjectPicker
          label={ADD_TO_PROJECT_LABEL}
          excludeIds={assignedIds}
          onPick={(project) =>
            attempt(setError, async () => {
              await call('assignments:assign', { projectId: project.id, assetId: asset.id });
              assignments.reload();
            })
          }
        />
      </div>
    </div>
  );
}

/** The props of the Relations tab. */
interface RelationsPanelProps {
  /** The shown asset's id. */
  assetId: string;
  /** Its relations, loaded by the screen (the tab count uses them too). */
  relations: Loaded<Awaited<ReturnType<typeof call<'relations:list'>>>>;
  /** Disables the asset links while an import runs. */
  disabled: boolean;
  /** Opens another asset. */
  onOpenAsset(id: string): void;
}

/**
 * The asset's relations in both directions, with Remove, and a kind select with a picker to add one.
 *
 * @param props the asset id, its relations, whether the links are disabled and the open action
 * @returns the panel
 */
export function RelationsPanel({ assetId, relations, disabled, onOpenAsset }: RelationsPanelProps) {
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<RelationKind>('uses');
  const errors = [error, relations.error].filter((message): message is string => message !== null);

  return (
    <div className="space-y-3 pt-4">
      {distinct(errors).map((message) => (
        <p key={message} role="alert" className={ALERT}>
          {message}
        </p>
      ))}
      {relations.data !== null && relations.data.length === 0 && <p className={MUTED}>No relations</p>}
      <ul className="space-y-1">
        {(relations.data ?? []).map((item) => {
          const relation = relationLabel(item.kind, item.direction);
          return (
            <li key={`${item.fromAssetId}:${item.toAssetId}:${item.kind}`} className="flex items-center gap-2">
              <span className={MUTED}>{relation}</span>
              <Link
                onFollow={() => onOpenAsset(item.other.id)}
                disabled={disabled}
                title={disabled ? IMPORT_BUSY : undefined}
              >
                {item.other.name}
              </Link>
              <button
                type="button"
                className={BUTTON}
                aria-label={`Remove relation ${relation} ${item.other.name}`}
                title="Removes the relation only; both assets and their files are kept"
                onClick={() =>
                  void attempt(setError, async () => {
                    await call('relations:remove', {
                      fromAssetId: item.fromAssetId,
                      toAssetId: item.toAssetId,
                      kind: item.kind,
                    });
                    relations.reload();
                  })
                }
              >
                Remove
              </button>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap items-start gap-2">
        <select
          className={SELECT}
          aria-label="Relation kind"
          value={kind}
          onChange={(event) => setKind(RelationKindSchema.parse(event.target.value))}
        >
          {RelationKindSchema.options.map((option) => (
            <option key={option} value={option}>
              {relationLabel(option, 'outgoing')}
            </option>
          ))}
        </select>
        <AssetPicker
          excludeIds={[assetId]}
          onPick={async (other) => {
            await attempt(setError, async () => {
              await call('relations:add', { fromAssetId: assetId, toAssetId: other.id, kind });
              relations.reload();
            });
          }}
        />
      </div>
    </div>
  );
}
