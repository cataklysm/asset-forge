import { useEffect, useState } from 'react';
import {
  AssetStatusSchema,
  FileRoleSchema,
  RelationKindSchema,
  type AssetDetail,
  type FileRole,
  type RelationKind,
} from '@assetforge/contracts';
import { enqueueTitle } from '../analysis';
import { call, describeError } from '../api';
import { useAnalysisDialogs } from '../components/AnalysisDialogs';
import { AssetFilesTab } from '../components/AssetFilesTab';
import { AssetPicker } from '../components/AssetPicker';
import { AssignmentFields } from '../components/AssignmentFields';
import { CommitInput } from '../components/CommitInput';
import { Link } from '../components/Link';
import { importFailures, ResultStrip, type ResultFailure } from '../components/ResultStrip';
import { SourceList } from '../components/SourceList';
import { TagRow } from '../components/TagRow';
import { Tabs } from '../components/Tabs';
import { WorkflowSection } from '../components/WorkflowSection';
import { useZipChoice } from '../components/ZipChoiceDialog';
import { useLoad } from '../hooks/useLoad';
import { importTitle } from '../import-result';
import { useJobs } from '../jobs-context';
import { ANALYSE_ASSET_TITLE, ANALYSE_LABEL, label, relationLabel } from '../labels';
import type { AssetTab } from '../list-state';
import { useTags } from '../tags-context';
import { ALERT, BORDER, BUTTON, MUTED, PAGE_TITLE, SELECT } from '../ui';

const ROLES = FileRoleSchema.options;
const IMPORT_BUSY = 'Import in progress';

type Patch = Parameters<typeof call<'assets:update'>>[1]['patch'];

interface Props {
  id: string;
  tab: AssetTab;
  onTabChange(tab: AssetTab): void;
  onBack(): void;
  onOpenAsset(id: string): void;
  onOpenProject(id: string): void;
  onBusyChange(busy: boolean): void;
}

/** Runs a mutation and reports its error through `setError`; resolves to whether it succeeded. */
async function attempt(setError: (message: string | null) => void, action: () => Promise<unknown>): Promise<boolean> {
  setError(null);
  try {
    await action();
    return true;
  } catch (e) {
    setError(describeError(e));
    return false;
  }
}

export function AssetScreen({ id, tab, onTabChange, onBack, onOpenAsset, onOpenProject, onBusyChange }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [importRole, setImportRole] = useState<FileRole>('reference');
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ title: string; failures: ResultFailure[] } | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [fileCount, setFileCount] = useState<number | null>(null);
  const [fileCountError, setFileCountError] = useState<string | null>(null);
  // A finished job may have changed file records (e.g. AI tags): the Files tab and its count reload.
  const { resultToken } = useJobs();
  // A tag rename re-reads the asset (its tags) and reloads the Files tab.
  const { renameToken } = useTags();
  const analysis = useAnalysisDialogs({
    onStarted: (result) => setImportResult({ title: enqueueTitle(result), failures: [] }),
    onChanged: () => setReloadToken((t) => t + 1),
  });
  const zipChoice = useZipChoice();

  const loaded = useLoad(() => call('assets:get', { id }), [id, renameToken]);
  const types = useLoad(() => call('assetTypes:list', {}), []);
  const assignments = useLoad(() => call('assignments:listByAsset', { assetId: id }), [id]);
  const relations = useLoad(() => call('relations:list', { assetId: id }), [id]);
  // The asset returned by a mutation replaces the loaded one until the next load.
  const [asset, setAsset] = useState<AssetDetail | null>(null);
  useEffect(() => setAsset(loaded.data), [loaded.data]);

  // The Files tab count: the unfiltered total, refreshed after every change to the files.
  useEffect(() => {
    let cancelled = false;
    call('files:list', { limit: 1, offset: 0, scope: { kind: 'asset', assetId: id } })
      .then((page) => {
        if (cancelled) return;
        setFileCount(page.total);
        setFileCountError(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setFileCountError(describeError(e));
      });
    return () => {
      cancelled = true;
    };
  }, [id, reloadToken, resultToken]);

  useEffect(() => {
    onBusyChange(importing);
    return () => onBusyChange(false);
  }, [importing, onBusyChange]);

  function filesChanged() {
    setReloadToken((t) => t + 1);
    loaded.reload();
  }

  const saveAsset = (patch: Patch) =>
    attempt(setError, async () => setAsset(await call('assets:update', { id, patch })));

  /** Like `attempt`, but rejects after reporting, so that the source list keeps the typed text. */
  async function reported(action: () => Promise<unknown>): Promise<void> {
    if (!(await attempt(setError, action))) throw new Error('reported');
  }

  async function importFiles() {
    setError(null);
    setImporting(true);
    try {
      const sourcePaths = await call('dialog:pickFiles', {});
      if (sourcePaths.length === 0) return;
      const unpackArchives = await zipChoice.choose(sourcePaths);
      if (unpackArchives === null) return;
      const results = await call('files:import', { sourcePaths, target: { assetId: id, role: importRole }, unpackArchives });
      setImportResult({ title: importTitle(results, { duplicates: false }), failures: importFailures(results) });
      filesChanged();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setImporting(false);
    }
  }

  const breadcrumb = (
    <nav aria-label="Breadcrumb" className={`text-sm ${MUTED}`}>
      <Link onFollow={onBack} disabled={importing} title={importing ? IMPORT_BUSY : undefined}>
        Assets
      </Link>
    </nav>
  );

  if (asset === null) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-4 p-6">
        {breadcrumb}
        {loaded.error !== null ? (
          <p role="alert" className={ALERT}>
            {loaded.error}
          </p>
        ) : (
          <p className={MUTED}>Loading…</p>
        )}
      </div>
    );
  }

  const headerErrors = [error, loaded.error, types.error].filter((e): e is string => e !== null);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 p-6">
      {breadcrumb}
      <header className="space-y-2">
        <h1 className="sr-only">{asset.name}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <CommitInput
            label="Name"
            variant="inline"
            className={`h-12 min-w-64 flex-1 ${PAGE_TITLE}`}
            value={asset.name}
            maxLength={200}
            onCommit={(name) => saveAsset({ name })}
          />
          <select
            className={SELECT}
            aria-label="Type"
            value={asset.typeId}
            onChange={(e) => void saveAsset({ typeId: e.target.value })}
          >
            {(types.data ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <select
            className={SELECT}
            aria-label="Status"
            value={asset.status}
            onChange={(e) => void saveAsset({ status: AssetStatusSchema.parse(e.target.value) })}
          >
            {AssetStatusSchema.options.map((s) => (
              <option key={s} value={s}>
                {label(s)}
              </option>
            ))}
          </select>
          <div className="ml-auto flex items-center gap-2">
            <select
              className={SELECT}
              aria-label="Role for imported files"
              title="Import as"
              value={importRole}
              onChange={(e) => setImportRole(FileRoleSchema.parse(e.target.value))}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {label(r)}
                </option>
              ))}
            </select>
            <button type="button" className={BUTTON} disabled={importing} onClick={() => void importFiles()}>
              Import files
            </button>
            {importing && <span className={`text-sm ${MUTED}`}>Importing…</span>}
            <button
              type="button"
              className={BUTTON}
              disabled={analysis.blocked !== null}
              title={analysis.blocked ?? ANALYSE_ASSET_TITLE}
              onClick={() => analysis.start({ kind: 'asset', assetId: id })}
            >
              {ANALYSE_LABEL}
            </button>
          </div>
        </div>
        <div className="flex flex-wrap items-start gap-4">
          <CommitInput
            label="Description"
            multiline
            variant="inline"
            placeholder="Description"
            className="min-w-64 flex-1"
            value={asset.description}
            maxLength={5000}
            onCommit={(description) => saveAsset({ description })}
          />
          <div className="min-w-64 flex-1">
            <TagRow
              label="Asset tags"
              kind="asset"
              tags={asset.tags}
              onAdd={async (name) => setAsset(await call('assets:addTag', { assetId: id, name }))}
              onRemove={async (name) => setAsset(await call('assets:removeTag', { assetId: id, name }))}
            />
          </div>
          <div className="min-w-64 flex-1">
            <SourceList
              sources={asset.sources}
              disabled={importing}
              onAdd={(url) => reported(async () => setAsset(await call('assets:addSource', { assetId: id, url })))}
              onRemove={(sourceId) =>
                reported(async () => setAsset(await call('assets:removeSource', { assetId: id, sourceId })))
              }
              onOpen={(sourceId) => reported(() => call('assets:openSource', { assetId: id, sourceId }))}
            />
          </div>
        </div>
        {headerErrors.map((message) => (
          <p key={message} role="alert" className={ALERT}>
            {message}
          </p>
        ))}
      </header>

      {importResult !== null && (
        <ResultStrip
          title={importResult.title}
          failures={importResult.failures}
          onDismiss={() => setImportResult(null)}
        />
      )}

      <Tabs<AssetTab>
        label="Asset sections"
        active={tab}
        onChange={onTabChange}
        tabs={[
          { id: 'files', label: 'Files', count: fileCount },
          { id: 'workflow', label: 'Workflow' },
          { id: 'projects', label: 'Projects', count: assignments.data?.length ?? null },
          { id: 'relations', label: 'Relations', count: relations.data?.length ?? null },
        ]}
      >
        {tab === 'files' && fileCountError !== null && (
          <p role="alert" className={`mt-4 ${ALERT}`}>
            {fileCountError}
          </p>
        )}
        {tab === 'files' && (
          <AssetFilesTab
            asset={asset}
            reloadToken={reloadToken + resultToken + renameToken}
            onFilesChanged={filesChanged}
            onAssetChange={setAsset}
            onCountChange={setFileCount}
          />
        )}
        {tab === 'workflow' && (
          <div className="pt-4">
            <WorkflowSection assetId={id} assetTypeId={asset.typeId} />
          </div>
        )}
        {tab === 'projects' && (
          <ProjectsPanel
            asset={asset}
            assignments={assignments}
            disabled={importing}
            onOpenProject={onOpenProject}
          />
        )}
        {tab === 'relations' && (
          <RelationsPanel assetId={id} relations={relations} disabled={importing} onOpenAsset={onOpenAsset} />
        )}
      </Tabs>
      {analysis.dialogs}
      {zipChoice.dialog}
    </div>
  );
}

type Loaded<T> = { data: T | null; error: string | null; reload(): void };

interface ProjectsPanelProps {
  asset: AssetDetail;
  assignments: Loaded<Awaited<ReturnType<typeof call<'assignments:listByAsset'>>>>;
  disabled: boolean;
  onOpenProject(id: string): void;
}

function ProjectsPanel({ asset, assignments, disabled, onOpenProject }: ProjectsPanelProps) {
  const [error, setError] = useState<string | null>(null);
  const [projectToAdd, setProjectToAdd] = useState('');
  const projects = useLoad(() => call('projects:list', { limit: 200, offset: 0 }), []);

  const assigned = assignments.data ?? [];
  const assignedIds = new Set(assigned.map((a) => a.projectId));
  const unassigned = (projects.data?.items ?? []).filter((p) => !assignedIds.has(p.id));
  const effectiveProject = unassigned.some((p) => p.id === projectToAdd) ? projectToAdd : (unassigned[0]?.id ?? '');
  const errors = [error, assignments.error, projects.error].filter((e): e is string => e !== null);

  return (
    <div className="space-y-3 pt-4">
      {errors.map((message) => (
        <p key={message} role="alert" className={ALERT}>
          {message}
        </p>
      ))}
      {assignments.data !== null && assigned.length === 0 && <p className={MUTED}>Not assigned to any project</p>}
      <ul className="space-y-2">
        {assigned.map((a) => (
          <li key={a.projectId} className={`space-y-2 border-b pb-2 ${BORDER}`}>
            <div className="flex items-center gap-2">
              <Link
                onFollow={() => onOpenProject(a.projectId)}
                disabled={disabled}
                title={disabled ? IMPORT_BUSY : undefined}
              >
                {a.project.name}
              </Link>
              <button
                type="button"
                className={BUTTON}
                aria-label={`Remove ${asset.name} from ${a.project.name}`}
                title="Removes the assignment only; the asset and its files are kept"
                onClick={() =>
                  void attempt(setError, async () => {
                    await call('assignments:remove', { projectId: a.projectId, assetId: asset.id });
                    assignments.reload();
                  })
                }
              >
                Remove
              </button>
            </div>
            <AssignmentFields assignment={a} onChanged={() => assignments.reload()} />
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-2">
        <select
          className={SELECT}
          aria-label="Project to add"
          value={effectiveProject}
          onChange={(e) => setProjectToAdd(e.target.value)}
        >
          {unassigned.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={BUTTON}
          disabled={effectiveProject === ''}
          onClick={() =>
            void attempt(setError, async () => {
              await call('assignments:assign', { projectId: effectiveProject, assetId: asset.id });
              assignments.reload();
            })
          }
        >
          Add to project
        </button>
      </div>
    </div>
  );
}

interface RelationsPanelProps {
  assetId: string;
  relations: Loaded<Awaited<ReturnType<typeof call<'relations:list'>>>>;
  disabled: boolean;
  onOpenAsset(id: string): void;
}

function RelationsPanel({ assetId, relations, disabled, onOpenAsset }: RelationsPanelProps) {
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<RelationKind>('uses');
  const errors = [error, relations.error].filter((e): e is string => e !== null);

  return (
    <div className="space-y-3 pt-4">
      {errors.map((message) => (
        <p key={message} role="alert" className={ALERT}>
          {message}
        </p>
      ))}
      {relations.data !== null && relations.data.length === 0 && <p className={MUTED}>No relations</p>}
      <ul className="space-y-1">
        {(relations.data ?? []).map((r) => {
          const relation = relationLabel(r.kind, r.direction);
          return (
            <li key={`${r.fromAssetId}:${r.toAssetId}:${r.kind}`} className="flex items-center gap-2">
              <span className={MUTED}>{relation}</span>
              <Link
                onFollow={() => onOpenAsset(r.other.id)}
                disabled={disabled}
                title={disabled ? IMPORT_BUSY : undefined}
              >
                {r.other.name}
              </Link>
              <button
                type="button"
                className={BUTTON}
                aria-label={`Remove relation ${relation} ${r.other.name}`}
                title="Removes the relation only; both assets and their files are kept"
                onClick={() =>
                  void attempt(setError, async () => {
                    await call('relations:remove', { fromAssetId: r.fromAssetId, toAssetId: r.toAssetId, kind: r.kind });
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
          onChange={(e) => setKind(RelationKindSchema.parse(e.target.value))}
        >
          {RelationKindSchema.options.map((k) => (
            <option key={k} value={k}>
              {relationLabel(k, 'outgoing')}
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
