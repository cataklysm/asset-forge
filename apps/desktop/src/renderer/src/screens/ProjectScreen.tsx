import { ChevronDown, ChevronRight } from 'lucide-react';
import { Fragment, useState } from 'react';
import { ProjectStatusSchema, type ProjectMember } from '@assetforge/contracts';
import { call, describeError } from '../api';
import { AssetPicker } from '../components/AssetPicker';
import { AssignmentFields } from '../components/AssignmentFields';
import { CommitInput } from '../components/CommitInput';
import { Link } from '../components/Link';
import { Pager } from '../components/Pager';
import { useLoad } from '../hooks/useLoad';
import { label } from '../labels';
import type { View } from '../nav';
import { useTags } from '../tags-context';
import { ALERT, BORDER, BUTTON_INLINE, ICON_BUTTON_INLINE, LABEL, MUTED, PAGE_TITLE, SECTION_TITLE, SELECT } from '../ui';

const PAGE_SIZE = 50;

export function ProjectScreen({ id, onNavigate }: { id: string; onNavigate(view: View): void }) {
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const { renameToken } = useTags();

  const project = useLoad(() => call('projects:get', { id }), [id]);
  const types = useLoad(() => call('assetTypes:list', {}), []);
  const members = useLoad(
    () => call('assignments:listByProject', { projectId: id, limit: PAGE_SIZE, offset }),
    // A tag rename reloads the members page, as it does every list.
    [id, offset, renameToken],
  );
  // The picker must exclude every member, not only those on the visible page.
  const allMembers = useLoad(
    () => call('assignments:listByProject', { projectId: id, limit: 200, offset: 0 }),
    [id],
  );

  function reloadMembers() {
    members.reload();
    allMembers.reload();
  }

  async function run(action: () => Promise<unknown>): Promise<boolean> {
    setError(null);
    try {
      await action();
      return true;
    } catch (e) {
      setError(describeError(e));
      return false;
    }
  }

  const saveProject = (patch: Parameters<typeof call<'projects:update'>>[1]['patch']) =>
    run(async () => {
      await call('projects:update', { id, patch });
      project.reload();
    });

  function toggleNotes(assetId: string) {
    setExpanded((old) => {
      const next = new Set(old);
      if (!next.delete(assetId)) next.add(assetId);
      return next;
    });
  }

  const data = project.data;
  const typeName = (typeId: string) => (types.data ?? []).find((t) => t.id === typeId)?.name ?? '–';
  const loadErrors = [error, project.error, types.error, members.error, allMembers.error].filter(
    (e): e is string => e !== null,
  );

  const breadcrumb = (
    <nav aria-label="Breadcrumb" className={`text-sm ${MUTED}`}>
      <Link onFollow={() => onNavigate({ name: 'projects' })}>Projects</Link>
      {data !== null && (
        <>
          <span> / </span>
          <span className="text-text">{data.name}</span>
        </>
      )}
    </nav>
  );

  if (data === null) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-4 p-6">
        {breadcrumb}
        {loadErrors.map((message) => (
          <p key={message} role="alert" className={ALERT}>
            {message}
          </p>
        ))}
        {project.error === null && <p className={MUTED}>Loading…</p>}
      </div>
    );
  }

  const items = members.data?.items ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-auto p-6">
      {breadcrumb}
      <header className="space-y-2">
        <h1 className="sr-only">{data.name}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <CommitInput
            label="Name"
            variant="inline"
            className={`h-12 min-w-64 flex-1 ${PAGE_TITLE}`}
            value={data.name}
            maxLength={200}
            onCommit={(name) => saveProject({ name })}
          />
          <select
            className={SELECT}
            aria-label="Status"
            value={data.status}
            onChange={(e) => void saveProject({ status: ProjectStatusSchema.parse(e.target.value) })}
          >
            {ProjectStatusSchema.options.map((s) => (
              <option key={s} value={s}>
                {label(s)}
              </option>
            ))}
          </select>
        </div>
        <CommitInput
          label="Description"
          multiline
          variant="inline"
          placeholder="Description"
          className="w-full"
          value={data.description}
          maxLength={5000}
          onCommit={(description) => saveProject({ description })}
        />
        {loadErrors.map((message) => (
          <p key={message} role="alert" className={ALERT}>
            {message}
          </p>
        ))}
      </header>

      <section className="space-y-3" aria-label="Assets">
        <h2 className={SECTION_TITLE}>Assets</h2>
        {members.data !== null && members.data.total === 0 ? (
          <p className={MUTED}>No assets assigned</p>
        ) : (
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
              {items.map((m) => (
                <MemberRows
                  key={m.assetId}
                  member={m}
                  projectName={data.name}
                  typeName={typeName(m.asset.typeId)}
                  notesOpen={expanded.has(m.assetId)}
                  onToggleNotes={() => toggleNotes(m.assetId)}
                  onOpenAsset={() => onNavigate({ name: 'asset', id: m.assetId })}
                  onChanged={reloadMembers}
                  onRemove={() =>
                    void run(async () => {
                      await call('assignments:remove', { projectId: id, assetId: m.assetId });
                      reloadMembers();
                    })
                  }
                />
              ))}
            </tbody>
          </table>
        )}
        {members.data !== null && members.data.total > PAGE_SIZE && (
          <Pager offset={offset} limit={PAGE_SIZE} total={members.data.total} onChange={setOffset} />
        )}
        <div className="flex flex-col gap-2">
          <h3 className={LABEL}>Add asset</h3>
          <AssetPicker
            excludeIds={(allMembers.data?.items ?? []).map((m) => m.assetId)}
            onPick={async (asset) => {
              await run(async () => {
                await call('assignments:assign', { projectId: id, assetId: asset.id });
                reloadMembers();
              });
            }}
          />
        </div>
      </section>
    </div>
  );
}

interface MemberRowsProps {
  member: ProjectMember;
  projectName: string;
  typeName: string;
  notesOpen: boolean;
  onToggleNotes(): void;
  onOpenAsset(): void;
  onChanged(): void;
  onRemove(): void;
}

/** One member: its main row and, when expanded, a row with the assignment notes. */
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
