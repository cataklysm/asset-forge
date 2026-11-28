import { useEffect, useRef, useState } from 'react';
import type { AssetDetail, FileRole, FileTarget } from '@assetforge/contracts';
import { enqueueTitle } from '../analysis';
import { call, describeError } from '../api';
import { attempt } from '../attempt';
import { useAnalysisDialogs } from '../components/AnalysisDialogs';
import { AssetFilesTab } from '../components/AssetFilesTab';
import { AssetHeader, type AssetPatch } from '../components/AssetHeader';
import { IMPORT_BUSY, ProjectsPanel, RelationsPanel } from '../components/AssetPanels';
import { Link } from '../components/Link';
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
  /** The failure of the last read; null without one. */
  fileCountError: string | null;
}

/**
 * The Files tab count: the unfiltered total, read again whenever a token changes.
 *
 * @param id the asset's id
 * @param reloadToken changes after the user's own changes to the files
 * @param countToken changes when a job added a file to the asset
 * @returns the count, its setter and the read's failure
 */
function useFileCount(id: string, reloadToken: number, countToken: number): FileCount {
  const [fileCount, setFileCount] = useState<number | null>(null);
  const [fileCountError, setFileCountError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    call('files:list', { limit: 1, offset: 0, scope: { kind: 'asset', assetId: id } })
      .then((page) => {
        if (cancelled) return;
        setFileCount(page.total);
        setFileCountError(null);
      })
      .catch((error: unknown) => {
        if (!cancelled) setFileCountError(describeError(error));
      });
    return () => {
      cancelled = true;
    };
  }, [id, reloadToken, countToken]);
  return { fileCount, setFileCount, fileCountError };
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
  // The target of the open URL import dialog: the role as chosen when the dialog opened.
  const [urlImportTarget, setUrlImportTarget] = useState<FileTarget | null>(null);
  // The same for the open site import dialog.
  const [siteImportTarget, setSiteImportTarget] = useState<FileTarget | null>(null);
  const [importResult, setImportResult] = useState<BatchResult | null>(null);
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
    onStarted: (result) => setImportResult({ title: enqueueTitle(result), failures: [] }),
    onChanged: () => setReloadToken((token) => token + 1),
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
  const { fileCount, setFileCount, fileCountError } = useFileCount(id, reloadToken, countToken);

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
    attempt(setError, async () => setAsset(await call('assets:update', { id, patch })));

  /** Like `attempt`, but rejects after reporting, so that the source list keeps the typed text. */
  async function reported(action: () => Promise<unknown>, describe = describeError): Promise<void> {
    if (!(await attempt(setError, action, describe))) throw new Error('reported');
  }

  /** Picks files, asks about archives, imports them into the asset with the chosen role and shows the result. */
  async function importFiles() {
    setError(null);
    setImporting(true);
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
      setImportResult({
        title: importTitle(results, { duplicates: false, cancelled }),
        failures: importFailures(results),
      });
      filesChanged();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setRunning(false);
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

  const headerErrors = [error, loaded.error, types.error].filter((message): message is string => message !== null);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 p-6">
      {breadcrumb}
      <AssetHeader
        assetId={id}
        asset={asset}
        types={types.data}
        onSave={saveAsset}
        onAssetChange={setAsset}
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
            reloadToken={reloadToken + renameToken}
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
