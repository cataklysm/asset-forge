import { useEffect, useRef, useState } from 'react';
import type { AssetDetail, FileRole, FileTarget } from '@assetforge/contracts';
import { enqueueTitle } from '../analysis';
import { call, describeError } from '../api';
import { attempt } from '../attempt';
import { runExclusive } from '../exclusive';
import { useAnalysisDialogs } from '../components/AnalysisDialogs';
import { AssetFilesTab } from '../components/AssetFilesTab';
import { AssetHeader, type AssetPatch } from '../components/AssetHeader';
import { IMPORT_BUSY, ProjectsPanel, RelationsPanel } from '../components/AssetPanels';
import { Breadcrumb } from '../components/Breadcrumb';
import { importFailures, ResultStrip, type BatchResult } from '../components/ResultStrip';
import { Tabs } from '../components/Tabs';
import { WorkflowSection } from '../components/WorkflowSection';
import { SiteImportDialog } from '../components/SiteImportDialog';
import { UrlImportDialog } from '../components/UrlImportDialog';
import { useZipChoice } from '../components/ZipChoiceDialog';
import { useLoad } from '../hooks/useLoad';
import { useImportProgress, useImportReload } from '../import-progress';
import { importTitle } from '../import-result';
import { useChanges } from '../jobs-context';
import {
  ASSET_SECTIONS_LABEL,
  ASSETS_BREADCRUMB_LINK,
  FILES_TAB_LABEL,
  LOADING_LABEL,
  PROJECTS_TAB_LABEL,
  RELATIONS_TAB_LABEL,
  WORKFLOW_TAB_LABEL,
} from '../labels';
import type { AssetTab } from '../list-state';
import { useTags } from '../tags-context';
import { ALERT, MUTED } from '../ui';

// The asset screen: the header, the import, and the Files, Workflow, Projects and Relations tabs.

/** The props of the asset screen. */
interface Props {
  /** The shown asset's id. */
  id: string;
  /** The open tab; kept by the shell. */
  tab: AssetTab;
  /** Opens another tab. */
  onTabChange(tab: AssetTab): void;
  /** Back to the asset gallery. */
  onBack(): void;
  /** Opens another asset (a relation). */
  onOpenAsset(id: string): void;
  /** Opens a project (an assignment). */
  onOpenProject(id: string): void;
  /** True while an import runs; the shell blocks navigation meanwhile. */
  onBusyChange(busy: boolean): void;
}

/** The Files tab count and how it is read. */
interface FileCount {
  /** The unfiltered number of the asset's files; null until read. */
  fileCount: number | null;
  /** Sets the count the Files tab reports. */
  setFileCount(count: number | null): void;
}

/**
 * The Files tab count: the unfiltered total, read again whenever a token changes. A failed read
 * keeps the last count: the file list beside it names the failure with its own Retry.
 *
 * @param id the asset's id
 * @param reloadToken changes after the user's own changes to the files
 * @param countToken changes when a job added a file to the asset
 * @returns the count and its setter
 */
function useFileCount(id: string, reloadToken: number, countToken: number): FileCount {
  const [fileCount, setFileCount] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    call('files:list', { limit: 1, offset: 0, scope: { kind: 'asset', assetId: id } })
      .then((page) => {
        if (!cancelled) setFileCount(page.total);
      })
      // The list reads the same files and shows the failure; the count only waits for the next read.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [id, reloadToken, countToken]);
  return { fileCount, setFileCount };
}

/** An asset as read, with the number of mutations seen when the read started. */
interface AssetRead {
  /** The asset. */
  asset: AssetDetail;
  /** The mutation count when the read started. */
  mutations: number;
}

/**
 * Reads the asset and notes how many mutations had answered when the read started.
 *
 * @param id the asset's id
 * @param mutations the screen's mutation count
 * @returns the asset with the count
 */
async function readAsset(id: string, mutations: { readonly current: number }): Promise<AssetRead> {
  const started = mutations.current;
  return { asset: await call('assets:get', { id }), mutations: started };
}

/**
 * One asset with its header, import and tabs.
 *
 * @param props the asset id, the open tab and the shell's callbacks
 * @returns the screen
 */
export function AssetScreen({ id, tab, onTabChange, onBack, onOpenAsset, onOpenProject, onBusyChange }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [importRole, setImportRole] = useState<FileRole>('reference');
  const [importing, setImporting] = useState(false);
  // Synchronous guard: a second activation before the re-render must not start a second import.
  const importingRef = useRef(false);
  // The target of the open URL import dialog: the role as chosen when the dialog opened.
  const [urlImportTarget, setUrlImportTarget] = useState<FileTarget | null>(null);
  // The same for the open site import dialog.
  const [siteImportTarget, setSiteImportTarget] = useState<FileTarget | null>(null);
  // The strip above the tabs: the result of an import or of an analysis start.
  const [result, setResult] = useState<BatchResult | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  // A file a job added to this asset (or a reset of the change feed) changes the Files tab count; the
  // tab's list follows the change feed itself.
  const [countToken, setCountToken] = useState(0);
  useChanges((changes) => {
    if (changes.reset || changes.added.some((place) => place.assetId === id)) setCountToken((token) => token + 1);
  });
  // A tag rename re-reads the asset (its tags) and reloads the Files tab.
  const { renameToken } = useTags();
  const analysis = useAnalysisDialogs({
    onStarted: (counts) => setResult({ title: enqueueTitle(counts), failures: [] }),
    onChanged: () => setReloadToken((token) => token + 1),
  });
  const zipChoice = useZipChoice();

  // Counts the mutations whose answer replaced the asset; a read started before the last of them is older.
  const mutations = useRef(0);
  const loaded = useLoad(() => readAsset(id, mutations), [id, renameToken]);
  const types = useLoad(() => call('assetTypes:list', {}), []);
  const assignments = useLoad(() => call('assignments:listByAsset', { assetId: id }), [id]);
  const relations = useLoad(() => call('relations:list', { assetId: id }), [id]);
  // The asset returned by a mutation replaces the loaded one until the next load.
  const [asset, setAsset] = useState<AssetDetail | null>(null);
  useEffect(() => {
    if (loaded.data === null || loaded.data.mutations === mutations.current) setAsset(loaded.data?.asset ?? null);
  }, [loaded.data]);

  /**
   * Shows the asset a mutation answered; a read still under way no longer replaces it.
   *
   * @param next the asset as the mutation left it
   */
  function changeAsset(next: AssetDetail) {
    mutations.current += 1;
    setAsset(next);
  }

  // The Files tab count: the unfiltered total, refreshed after every change to the files.
  const { fileCount, setFileCount } = useFileCount(id, reloadToken, countToken);

  useEffect(() => {
    onBusyChange(importing);
    return () => onBusyChange(false);
  }, [importing, onBusyChange]);

  /** The user changed files: the Files tab and its count reload, and the asset is read again. */
  function filesChanged() {
    setReloadToken((token) => token + 1);
    loaded.reload();
  }

  // While the `files:import` call is pending: its progress, and the Files tab and its count fill
  // meanwhile (the asset itself is read again once the import has ended).
  const [running, setRunning] = useState(false);
  const importProgress = useImportProgress(running);
  const cancelRequested = useRef(false);
  cancelRequested.current = importProgress.cancelRequested;
  useImportReload(running, importProgress.progress, () => setReloadToken((token) => token + 1));

  const saveAsset = (patch: AssetPatch) =>
    attempt(setError, async () => changeAsset(await call('assets:update', { id, patch })));

  /** Like `attempt`, but rejects after reporting, so that the source list keeps the typed text. */
  async function reported(action: () => Promise<unknown>, describe = describeError): Promise<void> {
    if (!(await attempt(setError, action, describe))) throw new Error('reported');
  }

  /**
   * Picks files, asks about archives, imports them into the asset with the chosen role and shows the result; one
   * import at a time.
   *
   * @returns settles when the import ended or was ignored
   */
  function importFiles(): Promise<void> {
    return runExclusive(
      importingRef,
      async () => {
        try {
          const sourcePaths = await call('dialog:pickFiles', {});
          if (sourcePaths.length === 0) return;
          const unpackArchives = await zipChoice.choose(sourcePaths);
          if (unpackArchives === null) return;
          // A cancel of an earlier import does not count for this one, even before the next render.
          cancelRequested.current = false;
          setRunning(true);
          const results = await call('files:import', {
            sourcePaths,
            target: { assetId: id, role: importRole },
            unpackArchives,
          });
          const cancelled = cancelRequested.current;
          setResult({
            title: importTitle(results, { duplicates: false, cancelled }),
            failures: importFailures(results),
          });
          filesChanged();
        } catch (caught) {
          setError(describeError(caught));
        }
      },
      {
        onStart: () => {
          setError(null);
          setImporting(true);
        },
        onEnd: () => {
          setRunning(false);
          setImporting(false);
        },
      },
    );
  }

  const breadcrumb = (
    <Breadcrumb
      listLabel={ASSETS_BREADCRUMB_LINK}
      current={asset?.name ?? null}
      onList={onBack}
      disabled={importing}
      title={importing ? IMPORT_BUSY : undefined}
    />
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
          <p className={MUTED}>{LOADING_LABEL}</p>
        )}
      </div>
    );
  }

  const headerErrors = [error, loaded.error].filter((message): message is string => message !== null);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 p-6">
      {breadcrumb}
      <AssetHeader
        assetId={id}
        asset={asset}
        types={types.data}
        typesError={types.error}
        onRetryTypes={types.reload}
        onSave={saveAsset}
        onAssetChange={changeAsset}
        reported={reported}
        errors={headerErrors}
        importRole={importRole}
        onImportRoleChange={setImportRole}
        importing={importing}
        importProgress={importProgress}
        onImportFiles={() => void importFiles()}
        onUrlImport={() => setUrlImportTarget({ assetId: id, role: importRole })}
        onSiteImport={() => setSiteImportTarget({ assetId: id, role: importRole })}
        analysisBlocked={analysis.blocked}
        onAnalyse={() => analysis.start({ kind: 'asset', assetId: id })}
      />

      {result !== null && (
        <ResultStrip title={result.title} failures={result.failures} onDismiss={() => setResult(null)} />
      )}

      <Tabs<AssetTab>
        label={ASSET_SECTIONS_LABEL}
        active={tab}
        onChange={onTabChange}
        tabs={[
          { id: 'files', label: FILES_TAB_LABEL, count: fileCount },
          { id: 'workflow', label: WORKFLOW_TAB_LABEL },
          { id: 'projects', label: PROJECTS_TAB_LABEL, count: assignments.data?.length ?? null },
          { id: 'relations', label: RELATIONS_TAB_LABEL, count: relations.data?.length ?? null },
        ]}
      >
        {tab === 'files' && (
          <AssetFilesTab
            asset={asset}
            reloadToken={reloadToken + renameToken}
            onFilesChanged={filesChanged}
            onAssetChange={changeAsset}
            onCountChange={setFileCount}
          />
        )}
        {tab === 'workflow' && (
          <div className="pt-4">
            <WorkflowSection assetId={id} assetTypeId={asset.typeId} />
          </div>
        )}
        {tab === 'projects' && (
          <ProjectsPanel asset={asset} assignments={assignments} disabled={importing} onOpenProject={onOpenProject} />
        )}
        {tab === 'relations' && (
          <RelationsPanel assetId={id} relations={relations} disabled={importing} onOpenAsset={onOpenAsset} />
        )}
      </Tabs>
      {analysis.dialogs}
      {zipChoice.dialog}
      {urlImportTarget !== null && (
        <UrlImportDialog target={urlImportTarget} onClose={() => setUrlImportTarget(null)} />
      )}
      {siteImportTarget !== null && (
        <SiteImportDialog
          target={siteImportTarget}
          onClose={() => setSiteImportTarget(null)}
          onImported={() => loaded.reload()}
        />
      )}
    </div>
  );
}
