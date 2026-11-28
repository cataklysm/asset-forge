import { useState } from 'react';
import { ProjectStatusSchema, type Project } from '@assetforge/contracts';
import { call, describeError } from '../api';
import { AssetPicker } from '../components/AssetPicker';
import { CommitInput } from '../components/CommitInput';
import { Link } from '../components/Link';
import { Pager } from '../components/Pager';
import { useLoad } from '../hooks/useLoad';
import { label } from '../labels';
import type { View } from '../nav';
import { useTags } from '../tags-context';
import { ALERT, LABEL, MUTED, PAGE_TITLE, SECTION_TITLE, SELECT } from '../ui';
import { MembersTable } from './ProjectMembers';

/** The members shown per page. */
const PAGE_SIZE = 50;

/** The fields `projects:update` takes. */
type ProjectPatch = Parameters<typeof call<'projects:update'>>[1]['patch'];

/**
 * The set with the id toggled.
 *
 * @param old the open ids
 * @param assetId the id to toggle
 * @returns a new set
 */
function toggled(old: ReadonlySet<string>, assetId: string): ReadonlySet<string> {
  const next = new Set(old);
  if (!next.delete(assetId)) next.add(assetId);
  return next;
}

/**
 * One project: name, status and description edited in place, its members and Add asset.
 *
 * @param props the project id and the navigation
 * @returns the screen
 */
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
  const allMembers = useLoad(() => call('assignments:listByProject', { projectId: id, limit: 200, offset: 0 }), [id]);

  function reloadMembers() {
    members.reload();
    allMembers.reload();
  }

  async function run(action: () => Promise<unknown>): Promise<boolean> {
    setError(null);
    try {
      await action();
      return true;
    } catch (failure) {
      setError(describeError(failure));
      return false;
    }
  }

  const saveProject = (patch: ProjectPatch) =>
    run(async () => {
      await call('projects:update', { id, patch });
      project.reload();
    });

  const data = project.data;
  const typeName = (typeId: string) => (types.data ?? []).find((type) => type.id === typeId)?.name ?? '–';
  const loadErrors = [error, project.error, types.error, members.error, allMembers.error].filter(
    (message): message is string => message !== null,
  );
  const breadcrumb = (
    <Breadcrumb projectName={data?.name ?? null} onProjects={() => onNavigate({ name: 'projects' })} />
  );

  if (data === null) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-4 p-6">
        {breadcrumb}
        <ErrorLines messages={loadErrors} />
        {project.error === null && <p className={MUTED}>Loading…</p>}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-auto p-6">
      {breadcrumb}
      <ProjectHeader project={data} errors={loadErrors} save={saveProject} />

      <section className="space-y-3" aria-label="Assets">
        <h2 className={SECTION_TITLE}>Assets</h2>
        {members.data !== null && members.data.total === 0 ? (
          <p className={MUTED}>No assets assigned</p>
        ) : (
          <MembersTable
            items={members.data?.items ?? []}
            projectName={data.name}
            typeName={typeName}
            expanded={expanded}
            onToggleNotes={(assetId) => setExpanded((old) => toggled(old, assetId))}
            onOpenAsset={(assetId) => onNavigate({ name: 'asset', id: assetId })}
            onChanged={reloadMembers}
            onRemove={(assetId) =>
              void run(async () => {
                await call('assignments:remove', { projectId: id, assetId });
                reloadMembers();
              })
            }
          />
        )}
        {members.data !== null && members.data.total > PAGE_SIZE && (
          <Pager offset={offset} limit={PAGE_SIZE} total={members.data.total} onChange={setOffset} />
        )}
        <div className="flex flex-col gap-2">
          <h3 className={LABEL}>Add asset</h3>
          <AssetPicker
            excludeIds={(allMembers.data?.items ?? []).map((member) => member.assetId)}
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

/**
 * The breadcrumb back to the projects list.
 *
 * @param props the project name once loaded, and the navigation to the list
 * @returns the breadcrumb navigation
 */
function Breadcrumb({ projectName, onProjects }: { projectName: string | null; onProjects(): void }) {
  return (
    <nav aria-label="Breadcrumb" className={`text-sm ${MUTED}`}>
      <Link onFollow={onProjects}>Projects</Link>
      {projectName !== null && (
        <>
          <span> / </span>
          <span className="text-text">{projectName}</span>
        </>
      )}
    </nav>
  );
}

/**
 * One alert line per message.
 *
 * @param props the messages
 * @returns the alert lines
 */
function ErrorLines({ messages }: { messages: readonly string[] }) {
  return (
    <>
      {/* Two loads can fail with the same message, so the position is the key. */}
      {messages.map((message, index) => (
        <p key={index} role="alert" className={ALERT}>
          {message}
        </p>
      ))}
    </>
  );
}

/** The props of `ProjectHeader`. */
interface HeaderProps {
  project: Project;
  /** The load and action errors. */
  errors: readonly string[];
  save(patch: ProjectPatch): Promise<boolean>;
}

/**
 * The project name, status and description, each saved on commit, with the error lines.
 *
 * @param props the project, the errors and the save
 * @returns the header
 */
function ProjectHeader({ project, errors, save }: HeaderProps) {
  return (
    <header className="space-y-2">
      <h1 className="sr-only">{project.name}</h1>
      <div className="flex flex-wrap items-center gap-2">
        <CommitInput
          label="Name"
          variant="inline"
          className={`h-12 min-w-64 flex-1 ${PAGE_TITLE}`}
          value={project.name}
          maxLength={200}
          onCommit={(name) => save({ name })}
        />
        <select
          className={SELECT}
          aria-label="Status"
          value={project.status}
          onChange={(event) => void save({ status: ProjectStatusSchema.parse(event.target.value) })}
        >
          {ProjectStatusSchema.options.map((status) => (
            <option key={status} value={status}>
              {label(status)}
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
        value={project.description}
        maxLength={5000}
        onCommit={(description) => save({ description })}
      />
      <ErrorLines messages={errors} />
    </header>
  );
}
