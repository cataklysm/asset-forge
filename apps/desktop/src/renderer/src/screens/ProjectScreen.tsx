import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ProjectStatusSchema, type Project, type ProjectMember } from '@assetforge/contracts';
import { call, describeError } from '../api';
import { AssetPicker } from '../components/AssetPicker';
import { Breadcrumb } from '../components/Breadcrumb';
import { CommitInput } from '../components/CommitInput';
import { Pager } from '../components/Pager';
import { useLoad } from '../hooks/useLoad';
import {
  ADD_ASSET_LABEL,
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

/**
 * The loads of the project screen: the project, the asset types, the shown member page and every member.
 *
 * @param projectId the project
 * @param offset the offset of the shown member page
 * @returns the four loads
 */
function useProjectLoads(projectId: string, offset: number) {
  const { renameToken } = useTags();
  const project = useLoad(() => call('projects:get', { id: projectId }), [projectId]);
  const types = useLoad(() => call('assetTypes:list', {}), []);
  const members = useLoad(
    () => call('assignments:listByProject', { projectId, limit: PAGE_SIZE, offset }),
    // A tag rename reloads the members page, as it does every list.
    [projectId, offset, renameToken],
  );
  // The picker must exclude every member, not only those on the visible page.
  const allMembers = useLoad(
    () => call('assignments:listByProject', { projectId, limit: 200, offset: 0 }),
    [projectId],
  );
  return { project, types, members, allMembers };
}

/** What the actions of the project screen act on. */
interface ActionDependencies {
  projectId: string;
  /** Shows the failure of an action, or clears it with null. */
  setError(message: string | null): void;
  reloadProject(): void;
  /** Reads the shown member page and the full member list again. */
  reloadMembers(): void;
}

/**
 * Sends one request, clearing the last failure first and showing a new one; reloads after a success.
 *
 * @param dependencies where the failure goes
 * @param request the request
 * @param reload what to read again after a success
 * @returns true when the request succeeded
 */
async function runAction(
  dependencies: ActionDependencies,
  request: () => Promise<unknown>,
  reload: () => void,
): Promise<boolean> {
  dependencies.setError(null);
  try {
    await request();
    reload();
    return true;
  } catch (failure) {
    dependencies.setError(describeError(failure));
    return false;
  }
}

/**
 * Saves fields of the project and reads it again.
 *
 * @param dependencies the project and its reload
 * @param patch the changed fields
 * @returns true when saved
 */
function saveProject(dependencies: ActionDependencies, patch: ProjectPatch): Promise<boolean> {
  const id = dependencies.projectId;
  return runAction(dependencies, () => call('projects:update', { id, patch }), dependencies.reloadProject);
}

/**
 * Removes one member from the project; the asset and its files are kept.
 *
 * @param dependencies the project and the member reload
 * @param assetId the member asset
 * @returns true when removed
 */
function removeMember(dependencies: ActionDependencies, assetId: string): Promise<boolean> {
  const projectId = dependencies.projectId;
  return runAction(dependencies, () => call('assignments:remove', { projectId, assetId }), dependencies.reloadMembers);
}

/**
 * Assigns one asset to the project.
 *
 * @param dependencies the project and the member reload
 * @param assetId the asset to add
 */
async function assignMember(dependencies: ActionDependencies, assetId: string): Promise<void> {
  const projectId = dependencies.projectId;
  await runAction(dependencies, () => call('assignments:assign', { projectId, assetId }), dependencies.reloadMembers);
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
  const { project, types, members, allMembers } = useProjectLoads(id, offset);
  useLastPageClamp(members.data?.total ?? null, offset, setOffset);

  const actions: ActionDependencies = {
    projectId: id,
    setError,
    reloadProject: project.reload,
    reloadMembers: () => {
      members.reload();
      allMembers.reload();
    },
  };

  const data = project.data;
  const typeName = (typeId: string) => (types.data ?? []).find((type) => type.id === typeId)?.name ?? '–';
  const loadErrors = [error, project.error, types.error, members.error, allMembers.error].filter(
    (message): message is string => message !== null,
  );
  const breadcrumb = (
    <Breadcrumb
      listLabel={PROJECTS_BREADCRUMB_LINK}
      current={data?.name ?? null}
      onList={() => onNavigate({ name: 'projects' })}
    />
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
      <ProjectHeader project={data} errors={loadErrors} save={(patch) => saveProject(actions, patch)} />

      <MembersSection
        page={members.data}
        memberIds={(allMembers.data?.items ?? []).map((member) => member.assetId)}
        projectName={data.name}
        typeName={typeName}
        offset={offset}
        onOffsetChange={setOffset}
        onOpenAsset={(assetId) => onNavigate({ name: 'asset', id: assetId })}
        actions={actions}
      />
    </div>
  );
}

/** The props of `MembersSection`. */
interface MembersSectionProps {
  /** The shown member page once loaded. */
  page: { items: readonly ProjectMember[]; total: number } | null;
  /** Every member's asset id, left out of the picker. */
  memberIds: readonly string[];
  projectName: string;
  typeName(typeId: string): string;
  offset: number;
  onOffsetChange(offset: number): void;
  onOpenAsset(assetId: string): void;
  actions: ActionDependencies;
}

/**
 * The members of the project: the table or the empty line, the pager and Add asset.
 *
 * @param props the member page, the member ids, the page offset and the actions
 * @returns the section
 */
function MembersSection({ page, memberIds, offset, onOffsetChange, actions, ...table }: MembersSectionProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  return (
    <section className="space-y-3" aria-label={PROJECT_MEMBERS_SECTION}>
      <h2 className={SECTION_TITLE}>{PROJECT_MEMBERS_SECTION}</h2>
      {page !== null && page.total === 0 ? (
        <p className={MUTED}>{NO_ASSETS_ASSIGNED}</p>
      ) : (
        <MembersTable
          items={page?.items ?? []}
          {...table}
          expanded={expanded}
          onToggleNotes={(assetId) => setExpanded((old) => toggled(old, assetId))}
          onChanged={actions.reloadMembers}
          onRemove={(assetId) => void removeMember(actions, assetId)}
        />
      )}
      {page !== null && page.total > PAGE_SIZE && (
        <Pager offset={offset} limit={PAGE_SIZE} total={page.total} onChange={onOffsetChange} />
      )}
      <div className="flex flex-col gap-2">
        <h3 className={LABEL}>{ADD_ASSET_LABEL}</h3>
        <AssetPicker excludeIds={memberIds} onPick={(asset) => assignMember(actions, asset.id)} />
      </div>
    </section>
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
