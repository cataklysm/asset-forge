import { useEffect, useRef, useState } from 'react';
import type { FileRecord } from '@assetforge/contracts';
import { analysableFiles, NONE_ANALYSABLE, startAnalysis } from '../analysis';
import { call, describeError } from '../api';
import { FileBrowser } from '../components/FileBrowser';
import { FileDetailDialog } from '../components/FileDetailDialog';
import { AssignFileControl } from '../components/FileRoleControls';
import { InboxSelection } from '../components/InboxSelection';
import { Page } from '../components/Page';
import { importFailures, ResultStrip, type ResultFailure } from '../components/ResultStrip';
import { SelectionBar } from '../components/SelectionBar';
import { fileMenuItems } from '../file-actions';
import { useFileDialog } from '../hooks/useFileDialog';
import { useLoad } from '../hooks/useLoad';
import type { ViewPosition } from '../hooks/useVirtualRows';
import { useJobs } from '../jobs-context';
import type { AssetView, FileFilters, InboxListState } from '../list-state';
import { dropSelected, eligibleFiles, NO_SELECTION, NONE_ELIGIBLE, refreshSelected, type FileSelection } from '../selection';
import { ALERT, BUTTON, MUTED } from '../ui';

const INBOX = { kind: 'inbox' } as const;

interface Props {
  /** Filters and scroll offset; kept by the shell so that they survive navigation. */
  state: InboxListState;
  onStateChange(s: InboxListState): void;
  /** True while an import runs; the shell blocks navigation meanwhile. */
  onBusyChange(busy: boolean): void;
}

/**
 * The inbox: imported files that are not placed in an asset yet. Import, the file browser with
 * multi-select, and the Selection column for shared tags and the batch assign. The selection is
 * local and does not survive navigation.
 */
export function InboxScreen({ state, onStateChange, onBusyChange }: Props) {
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ title: string; failures: ResultFailure[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<AssetView>('grid');
  const [selection, setSelection] = useState<FileSelection>(NO_SELECTION);
  const [reloadToken, setReloadToken] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const tagInputRef = useRef<HTMLInputElement | null>(null);
  const positionRef = useRef<ViewPosition | null>(null);
  const detail = useFileDialog(containerRef);
  // Synchronous guard: a second activation before the re-render must not start a second import.
  const importingRef = useRef(false);
  const analysingRef = useRef(false);

  // A finished job may have changed records (e.g. AI tags): the list and the count reload.
  const { resultToken, refresh: refreshJobs } = useJobs();

  // The title shows the number of all inbox files, independent of the filters.
  const all = useLoad(() => call('files:list', { limit: 1, offset: 0, scope: INBOX }), [reloadToken, resultToken]);

  useEffect(() => {
    onBusyChange(importing);
    return () => onBusyChange(false);
  }, [importing, onBusyChange]);

  // Leaving the screen keeps the filters (already in `state`) and the scroll offset.
  const latest = useRef({ state, onStateChange });
  latest.current = { state, onStateChange };
  useEffect(
    () => () => {
      const position = positionRef.current;
      if (position === null) return;
      const current = latest.current;
      current.onStateChange({ ...current.state, scrollOffset: position.scrollOffset });
    },
    [],
  );

  const reload = () => setReloadToken((t) => t + 1);

  function setFilters(filters: FileFilters) {
    onStateChange({ ...state, filters, scrollOffset: 0 });
  }

  async function importFiles() {
    if (importingRef.current) return;
    importingRef.current = true;
    setError(null);
    setImporting(true);
    try {
      const sourcePaths = await call('dialog:pickFiles', {});
      if (sourcePaths.length === 0) return;
      const results = await call('files:import', { sourcePaths });
      const failures = importFailures(results);
      // A duplicate is still imported (it only has matching content), so it counts in both figures.
      const imported = results.filter((r) => r.file !== null).length;
      const duplicates = results.filter((r) => r.duplicateOf.length > 0).length;
      setImportResult({ title: `${imported} imported, ${failures.length} failed, ${duplicates} duplicates`, failures });
      reload();
    } catch (e) {
      setError(describeError(e));
    } finally {
      importingRef.current = false;
      setImporting(false);
    }
  }

  /** A changed record: the dialog and the selection show it, and the list reloads. */
  function fileChanged(file: FileRecord) {
    detail.update(file);
    filesChanged([file]);
  }

  /** Changed records refresh the selection as it is now; files no longer selected stay unselected. */
  function filesChanged(items: readonly FileRecord[]) {
    setSelection((current) => refreshSelected(current, items));
    reload();
  }

  /** Enqueues an analysis of `files`; the outcome shows in the result strip, the selection is kept. */
  async function analyse(files: readonly FileRecord[]) {
    if (analysingRef.current) return;
    analysingRef.current = true;
    setError(null);
    try {
      setImportResult(await startAnalysis(files));
      refreshJobs();
    } catch (e) {
      setError(describeError(e));
    } finally {
      analysingRef.current = false;
    }
  }

  /** Files that left the inbox: out of the selection, and the list reloads (the dialog moves on). */
  function moved(ids: readonly string[]) {
    setSelection((current) => dropSelected(current, ids));
    reload();
  }

  const importButton = (
    <button type="button" className={BUTTON} disabled={importing} onClick={() => void importFiles()}>
      Import files
    </button>
  );
  const noneEligible = eligibleFiles(selection).length === 0;
  const toAnalyse = analysableFiles(selection);
  const shown = detail.file;

  return (
    <Page
      title="Inbox"
      count={all.data?.total ?? null}
      countTitle="Files in the inbox"
      actions={
        <>
          {importing && <span className={`text-sm ${MUTED}`}>Importing…</span>}
          {importButton}
        </>
      }
      detail={
        selection.selected.size > 0 ? (
          <InboxSelection
            selection={selection}
            tagInputRef={tagInputRef}
            onAssigned={moved}
            onFilesChanged={filesChanged}
          />
        ) : undefined
      }
    >
      <div ref={containerRef} className="flex min-h-0 flex-1 flex-col gap-3">
        {[error, all.error].map(
          (message, index) =>
            message !== null && (
              <p key={index} role="alert" className={ALERT}>
                {message}
              </p>
            ),
        )}
        {importResult !== null && (
          <ResultStrip title={importResult.title} failures={importResult.failures} onDismiss={() => setImportResult(null)} />
        )}
        <SelectionBar count={selection.selected.size} onClear={() => setSelection(NO_SELECTION)}>
          <button
            type="button"
            className={BUTTON}
            disabled={noneEligible}
            title={noneEligible ? NONE_ELIGIBLE : undefined}
            onClick={() => tagInputRef.current?.focus()}
          >
            Add tags
          </button>
          <button
            type="button"
            className={BUTTON}
            disabled={toAnalyse.length === 0}
            title={toAnalyse.length === 0 ? NONE_ANALYSABLE : undefined}
            onClick={() => void analyse(toAnalyse)}
          >
            Analyse
          </button>
        </SelectionBar>
        <FileBrowser
          scope={INBOX}
          filters={state.filters}
          onFiltersChange={setFilters}
          showRoleFilter={false}
          view={view}
          onViewChange={setView}
          restore={{ scrollOffset: state.scrollOffset, index: null, focus: false }}
          positionRef={positionRef}
          selection={selection}
          onSelectionChange={setSelection}
          reloadToken={reloadToken + resultToken}
          onOpen={detail.open}
          menuItems={(file) =>
            fileMenuItems(file, { cover: null, onDetails: () => detail.open(file), onAnalyse: () => void analyse([file]), onError: setError })
          }
          emptyText="Inbox is empty"
          emptyAction={importButton}
          viewer={{
            fileId: shown?.id ?? null,
            onView: (file) => (file === null ? detail.close() : detail.show(file)),
            render: (list) =>
              shown !== null && (
                <FileDetailDialog
                  file={shown}
                  asset={null}
                  actions={{ cover: null, onDetails: () => {}, onAnalyse: () => void analyse([shown]), onError: setError }}
                  roleControl={<AssignFileControl file={shown} onAssigned={() => moved([shown.id])} fullWidth />}
                  onFileChange={fileChanged}
                  onMeasured={detail.setDimensions}
                  list={list}
                  onClose={detail.close}
                />
              ),
          }}
        />
      </div>
    </Page>
  );
}
