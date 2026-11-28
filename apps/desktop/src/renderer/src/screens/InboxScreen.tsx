import { useEffect, useRef, useState } from 'react';
import type { FileRecord } from '@assetforge/contracts';
import { enqueueTitle } from '../analysis';
import { call, describeError } from '../api';
import { SelectionAnalysisButtons, useAnalysisDialogs } from '../components/AnalysisDialogs';
import { FileBrowser } from '../components/FileBrowser';
import { FileDetailDialog } from '../components/FileDetailDialog';
import { AssignFileControl } from '../components/FileRoleControls';
import { ImportStatus } from '../components/ImportProgressView';
import { InboxSelection } from '../components/InboxSelection';
import { Page } from '../components/Page';
import { batchResult, importFailures, ResultStrip, type BatchResult } from '../components/ResultStrip';
import { SelectionBar } from '../components/SelectionBar';
import { SiteImportDialog } from '../components/SiteImportDialog';
import { UrlImportDialog } from '../components/UrlImportDialog';
import { useZipChoice } from '../components/ZipChoiceDialog';
import { runExclusive } from '../exclusive';
import { fileMenuItems } from '../file-actions';
import { useImportProgress, useImportReload } from '../import-progress';
import { importTitle } from '../import-result';
import { useExclusiveGuard } from '../hooks/useExclusiveGuard';
import { useFileDialog } from '../hooks/useFileDialog';
import { useKeptScrollOffset } from '../hooks/useKeptScrollOffset';
import { useLoad } from '../hooks/useLoad';
import type { ViewPosition } from '../hooks/useVirtualRows';
import { useChanges } from '../jobs-context';
import type { AssetView, FileFilters, InboxListState } from '../list-state';
import { DELETE_LABEL, DELETE_SELECTION_TITLE, SITE_IMPORT_LABEL, URL_IMPORT_LABEL } from '../labels';
import {
  dropSelected,
  eligibleFiles,
  NO_SELECTION,
  NONE_ELIGIBLE,
  refreshSelected,
  type FileSelection,
} from '../selection';
import { useStudio } from '../studio-context';
import { renameInRecord, renameInSelection } from '../tag-rename';
import { useRenamed, useTags } from '../tags-context';
import { runFileBatch, throwFirst } from '../trash-actions';
import { useTrash } from '../trash-context';
import { ALERT, BUTTON } from '../ui';

// The inbox screen: import, the inbox file list with multi-select, and the batch actions on the selection.

const INBOX = { kind: 'inbox' } as const;

/** The props of the inbox screen. */
interface Props {
  /** Filters and scroll offset; kept by the shell so that they survive navigation. */
  state: InboxListState;
  /** Hands changed filters or the kept scroll offset to the shell. */
  onStateChange(state: InboxListState): void;
  /** True while an import runs; the shell blocks navigation meanwhile. */
  onBusyChange(busy: boolean): void;
}

/**
 * The inbox: imported files that are not placed in an asset yet. Import, the file browser with
 * multi-select, and the Selection column for shared tags and the batch assign. The selection is
 * local and does not survive navigation.
 *
 * @param props the kept list state and the shell's callbacks
 * @returns the screen
 */
export function InboxScreen({ state, onStateChange, onBusyChange }: Props) {
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<BatchResult | null>(null);
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
  // The same for the deletes: one guard for a single delete and the selection's delete, so that they never overlap;
  // its busy flag disables the controls of both while either runs.
  const acting = useExclusiveGuard();
  const trash = useTrash();
  const zipChoice = useZipChoice();
  const [urlImportOpen, setUrlImportOpen] = useState(false);
  const [siteImportOpen, setSiteImportOpen] = useState(false);

  // A file a job added to the inbox (or a reset of the change feed) changes the count; the list
  // follows the change feed itself.
  const [countToken, setCountToken] = useState(0);
  useChanges((changes) => {
    if (changes.reset || changes.added.some((place) => place.assetId === null)) setCountToken((token) => token + 1);
  });

  // A tag rename reloads the list; the selection and the shown file are copies it does not reach.
  const { renameToken } = useTags();
  useRenamed((change) => {
    setSelection((current) => renameInSelection(current, change));
    const shown = detail.file;
    if (shown !== null) detail.update(renameInRecord(shown, change));
  });

  // The title shows the number of all inbox files, independent of the filters.
  const all = useLoad(() => call('files:list', { limit: 1, offset: 0, scope: INBOX }), [reloadToken, countToken]);

  useEffect(() => {
    onBusyChange(importing);
    return () => onBusyChange(false);
  }, [importing, onBusyChange]);

  // Leaving the screen keeps the filters (already in `state`) and the scroll offset.
  useKeptScrollOffset(positionRef, state, onStateChange);

  const reload = () => setReloadToken((token) => token + 1);

  // While the `files:import` call is pending: its progress, and the list fills meanwhile.
  const [running, setRunning] = useState(false);
  const importProgress = useImportProgress(running);
  const cancelRequested = useRef(false);
  cancelRequested.current = importProgress.cancelRequested;
  useImportReload(running, importProgress.progress, reload);

  const studio = useStudio();
  const analysis = useAnalysisDialogs({
    onStarted: (counts) => setResult({ title: enqueueTitle(counts), failures: [] }),
    onChanged: reload,
    onLeave: () => detail.close(),
  });

  function setFilters(filters: FileFilters) {
    onStateChange({ ...state, filters, scrollOffset: 0 });
  }

  /** Picks files, asks about archives, imports them into the inbox and shows the result; one import at a time. */
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
          const results = await call('files:import', { sourcePaths, unpackArchives });
          const cancelled = cancelRequested.current;
          setResult({
            title: importTitle(results, { duplicates: true, cancelled }),
            failures: importFailures(results),
          });
          reload();
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
  function remove(file: FileRecord): Promise<void> {
    return acting.run(async () => {
      const { firstError } = await runFileBatch('files:trashMany', [file]);
      throwFirst(firstError);
      moved([file.id]);
      trash.refresh();
    });
  }

  /** All selected files to the trash, not only the eligible ones; one batch at a time. */
  function deleteSelected(): Promise<void> {
    const files = [...selection.selected.values()];
    if (files.length === 0) return Promise.resolve();
    return acting.run(
      async () => {
        try {
          const { doneIds, failures } = await runFileBatch('files:trashMany', files);
          setResult(batchResult(doneIds.length, 'deleted', failures));
          moved(doneIds);
          trash.refresh();
        } catch (caught) {
          setError(describeError(caught));
        }
      },
      { onStart: () => setError(null) },
    );
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
          <ImportStatus state={importProgress} />
          {importButton}
          <button type="button" className={BUTTON} disabled={importing} onClick={() => setUrlImportOpen(true)}>
            {URL_IMPORT_LABEL}
          </button>
          <button type="button" className={BUTTON} disabled={importing} onClick={() => setSiteImportOpen(true)}>
            {SITE_IMPORT_LABEL}
          </button>
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
        {result !== null && (
          <ResultStrip title={result.title} failures={result.failures} onDismiss={() => setResult(null)} />
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
            disabled={acting.busy}
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
          reloadToken={reloadToken + renameToken}
          onOpen={detail.open}
          menuItems={(file) =>
            fileMenuItems(file, {
              cover: null,
              onDetails: () => detail.open(file),
              ...fileActions(file),
              onError: setError,
              actionBusy: acting.busy,
              onDelete: () => {
                setError(null);
                remove(file).catch((caught: unknown) => setError(describeError(caught)));
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
                    ...fileActions(shown),
                    onError: setError,
                    actionBusy: acting.busy,
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
        {urlImportOpen && <UrlImportDialog target={null} onClose={() => setUrlImportOpen(false)} />}
        {siteImportOpen && <SiteImportDialog target={null} onClose={() => setSiteImportOpen(false)} />}
      </div>
    </Page>
  );
}
