import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ProjectStatusSchema, type Project } from '@assetforge/contracts';
import { call, describeError } from '../api';
import { AssetPicker } from '../components/AssetPicker';
import { CommitInput } from '../components/CommitInput';
import { Link } from '../components/Link';
import { Pager } from '../components/Pager';
import { useLoad } from '../hooks/useLoad';
import {
  ADD_ASSET_LABEL,
  BREADCRUMB_LABEL,
  label,
  LOADING_LABEL,
  NO_ASSETS_ASSIGNED,
  PROJECT_DESCRIPTION_LABEL,
  PROJECT_MEMBERS_SECTION,
  PROJECT_NAME_FIELD,
  PROJECT_STATUS_SELECT,
  PROJECTS_BREADCRUMB_LINK,
} from '../labels';
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
 * The offset of the last member page that still shows a member.
 *
 * @param total the number of members
 * @returns the offset, 0 for no members
 */
function lastMemberPageOffset(total: number): number {
  return total <= 0 ? 0 : Math.floor((total - 1) / PAGE_SIZE) * PAGE_SIZE;
}

/**
 * The offset of the member page, reported on every change.
 *
 * @param initial the offset to start on
 * @param onChange called with every new offset
 * @returns the offset and its setter, which is stable
 */
function useMemberOffset(
  initial: number,
  onChange: ((offset: number) => void) | undefined,
): [number, (offset: number) => void] {
  const [offset, setOffset] = useState(initial);
  const onChangeRef = useRef(onChange);
  useLayoutEffect(() => {
    onChangeRef.current = onChange;
  });
  const change = useCallback((next: number) => {
    setOffset(next);
    onChangeRef.current?.(next);
  }, []);
  return [offset, change];
}

/**
 * Moves the member page back to the last page once the members end before it: a page kept from an
 * earlier visit, or the last member of the last page removed.
 *
 * @param total the number of members once loaded, else null
 * @param offset the shown offset
 * @param setOffset the setter of the offset
 */
function useLastPageClamp(total: number | null, offset: number, setOffset: (offset: number) => void): void {
  useEffect(() => {
    if (total !== null && offset > 0 && offset >= total) setOffset(lastMemberPageOffset(total));
  }, [total, offset, setOffset]);
}

/** The props of `ProjectScreen`. */
interface ProjectScreenProps {
  id: string;
  onNavigate(view: View): void;
  /** The member page to start on, e.g. the one shown when the user left this project. */
  initialMemberOffset?: number;
  /** Called with every new member page offset. */
  onMemberOffsetChange?(offset: number): void;
}

/**
 * One project: name, status and description edited in place, its members and Add asset.
 *
 * @param props the project id, the navigation and the member page kept by the shell
 * @returns the screen
 */
export function ProjectScreen({ id, onNavigate, initialMemberOffset = 0, onMemberOffsetChange }: ProjectScreenProps) {
  const [offset, setOffset] = useMemberOffset(initialMemberOffset, onMemberOffsetChange);
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
  useLastPageClamp(members.data?.total ?? null, offset, setOffset);

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
        {project.error === null && <p className={MUTED}>{LOADING_LABEL}</p>}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-auto p-6">
      {breadcrumb}
      <ProjectHeader project={data} errors={loadErrors} save={saveProject} />

      <section className="space-y-3" aria-label={PROJECT_MEMBERS_SECTION}>
        <h2 className={SECTION_TITLE}>{PROJECT_MEMBERS_SECTION}</h2>
        {members.data !== null && members.data.total === 0 ? (
          <p className={MUTED}>{NO_ASSETS_ASSIGNED}</p>
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
          <h3 className={LABEL}>{ADD_ASSET_LABEL}</h3>
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
    <nav aria-label={BREADCRUMB_LABEL} className={`text-sm ${MUTED}`}>
      <Link onFollow={onProjects}>{PROJECTS_BREADCRUMB_LINK}</Link>
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
          label={PROJECT_NAME_FIELD}
          variant="inline"
          className={`h-12 min-w-64 flex-1 ${PAGE_TITLE}`}
          value={project.name}
          maxLength={200}
          onCommit={(name) => save({ name })}
        />
        <select
          className={SELECT}
          aria-label={PROJECT_STATUS_SELECT}
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
        label={PROJECT_DESCRIPTION_LABEL}
        multiline
        variant="inline"
        placeholder={PROJECT_DESCRIPTION_LABEL}
        className="w-full"
        value={project.description}
        maxLength={5000}
        onCommit={(description) => save({ description })}
      />
      <ErrorLines messages={errors} />
    </header>
  );
}
