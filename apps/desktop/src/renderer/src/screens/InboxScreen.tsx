import { useEffect, useRef, useState } from 'react';
import type { FileRecord } from '@assetforge/contracts';
import { enqueueTitle } from '../analysis';
import { call, describeError } from '../api';
import { SelectionAnalysisButtons, useAnalysisDialogs } from '../components/AnalysisDialogs';
import { FileBrowser } from '../components/FileBrowser';
import { FileDetailDialog } from '../components/FileDetailDialog';
import { AssignFileControl } from '../components/FileRoleControls';
import { InboxSelection } from '../components/InboxSelection';
import { Page } from '../components/Page';
import { importFailures, ResultStrip, type ResultFailure } from '../components/ResultStrip';
import { SelectionBar } from '../components/SelectionBar';
import { useZipChoice } from '../components/ZipChoiceDialog';
import { fileMenuItems } from '../file-actions';
import { importTitle } from '../import-result';
import { useFileDialog } from '../hooks/useFileDialog';
import { useLoad } from '../hooks/useLoad';
import type { ViewPosition } from '../hooks/useVirtualRows';
import { useJobs } from '../jobs-context';
import type { AssetView, FileFilters, InboxListState } from '../list-state';
import { DELETE_LABEL, DELETE_SELECTION_TITLE } from '../labels';
import { dropSelected, eligibleFiles, NO_SELECTION, NONE_ELIGIBLE, refreshSelected, type FileSelection } from '../selection';
import { useStudio } from '../studio-context';
import { renameInRecord, renameInSelection } from '../tag-rename';
import { useRenamed, useTags } from '../tags-context';
import { runFileBatch, throwFirst } from '../trash-actions';
import { useTrash } from '../trash-context';
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
  // The same for a single delete and for the selection's delete.
  const acting = useRef(false);
  const deleting = useRef(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const trash = useTrash();
  const zipChoice = useZipChoice();

  // A finished job may have changed records (e.g. AI tags): the list and the count reload.
  const { resultToken } = useJobs();

  // A tag rename reloads the list; the selection and the shown file are copies it does not reach.
  const { renameToken } = useTags();
  useRenamed((change) => {
    setSelection((current) => renameInSelection(current, change));
    const shown = detail.file;
    if (shown !== null) detail.update(renameInRecord(shown, change));
  });

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

  const studio = useStudio();
  const analysis = useAnalysisDialogs({
    onStarted: (result) => setImportResult({ title: enqueueTitle(result), failures: [] }),
    onChanged: reload,
    onLeave: () => detail.close(),
  });

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
      const unpackArchives = await zipChoice.choose(sourcePaths);
      if (unpackArchives === null) return;
      const results = await call('files:import', { sourcePaths, unpackArchives });
      setImportResult({ title: importTitle(results, { duplicates: true }), failures: importFailures(results) });
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

  /** Files that left the inbox: out of the selection, and the list reloads (the dialog moves on). */
  function moved(ids: readonly string[]) {
    setSelection((current) => dropSelected(current, ids));
    reload();
  }

  /** One file to the trash (menu, dialog); one at a time. A failure rejects for the caller to show. */
  async function remove(file: FileRecord): Promise<void> {
    if (acting.current) return;
    acting.current = true;
    try {
      const { failures } = await runFileBatch('files:trashMany', [file]);
      throwFirst(failures);
      moved([file.id]);
      trash.refresh();
    } finally {
      acting.current = false;
    }
  }

  /** All selected files to the trash, not only the eligible ones; one batch at a time. */
  async function deleteSelected(): Promise<void> {
    const files = [...selection.selected.values()];
    if (deleting.current || files.length === 0) return;
    deleting.current = true;
    setDeleteBusy(true);
    setError(null);
    try {
      const { doneIds, failures } = await runFileBatch('files:trashMany', files);
      setImportResult(failures.length === 0 ? null : { title: `${doneIds.length} deleted, ${failures.length} failed`, failures });
      moved(doneIds);
      trash.refresh();
    } catch (e) {
      setError(describeError(e));
    } finally {
      deleting.current = false;
      setDeleteBusy(false);
    }
  }

  const importButton = (
    <button type="button" className={BUTTON} disabled={importing} onClick={() => void importFiles()}>
      Import files
    </button>
  );
  const noneEligible = eligibleFiles(selection).length === 0;
  const shown = detail.file;
  const fileActions = (file: FileRecord) => ({
    onAnalyse: () => analysis.analyseFiles([file]),
    onReviewTags: () => analysis.review(file),
    onImageToPrompt: () => analysis.prompt(file),
    analysisBlocked: analysis.blocked,
    studio,
  });

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
          <SelectionAnalysisButtons analysis={analysis} selection={selection} />
          <button
            type="button"
            className={BUTTON}
            disabled={deleteBusy}
            title={DELETE_SELECTION_TITLE}
            onClick={() => void deleteSelected()}
          >
            {DELETE_LABEL}
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
          reloadToken={reloadToken + resultToken + renameToken}
          onOpen={detail.open}
          menuItems={(file) =>
            fileMenuItems(file, {
              cover: null,
              onDetails: () => detail.open(file),
              ...fileActions(file),
              onError: setError,
              onDelete: () => {
                setError(null);
                remove(file).catch((e: unknown) => setError(describeError(e)));
              },
            })
          }
          onDeleteKey={() => void deleteSelected()}
          analysis={{
            onAnalyseAll: (filter) => analysis.start({ kind: 'fileFilter', filter }),
            blocked: analysis.blocked,
          }}
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
                  actions={{
                    cover: null,
                    onDetails: () => {},
                    ...fileActions(shown),
                    onError: setError,
                    onDelete: () => remove(shown),
                  }}
                  roleControl={<AssignFileControl file={shown} onAssigned={() => moved([shown.id])} fullWidth />}
                  onFileChange={fileChanged}
                  onMeasured={detail.setDimensions}
                  list={list}
                  onClose={detail.close}
                />
              ),
          }}
        />
        {analysis.dialogs}
        {zipChoice.dialog}
      </div>
    </Page>
  );
}
