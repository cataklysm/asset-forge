import { useRef, useState } from 'react';
import type { AssetDetail, FileRecord, FileRole } from '@assetforge/contracts';
import { enqueueTitle } from '../analysis';
import { call, describeError } from '../api';
import { runExclusive } from '../exclusive';
import { fileMenuItems } from '../file-actions';
import { useStudio } from '../studio-context';
import { SEARCH_DEBOUNCE_MS, useDebouncedValue } from '../hooks/useDebouncedValue';
import { useFileDialog } from '../hooks/useFileDialog';
import { DELETE_LABEL, DELETE_SELECTION_TITLE } from '../labels';
import { hasFilters, NO_FILE_FILTERS, renameInFilters, type AssetView, type FileFilters } from '../list-state';
import {
  dropSelected,
  eligibleFiles,
  NO_SELECTION,
  NONE_ELIGIBLE,
  refreshSelected,
  type FileSelection,
} from '../selection';
import { renameInRecord, renameInSelection } from '../tag-rename';
import { useRenamed, useTags } from '../tags-context';
import { runFileBatch, throwFirst } from '../trash-actions';
import { useTrash } from '../trash-context';
import { ALERT, BUTTON } from '../ui';
import { SelectionAnalysisButtons, useAnalysisDialogs } from './AnalysisDialogs';
import { AddTagsDialog, SetRoleDialog } from './AssetBatchDialogs';
import { FileBrowser } from './FileBrowser';
import { FileDetailDialog } from './FileDetailDialog';
import { FileRoleSelect } from './FileRoleControls';
import { assignFailures, batchResult, ResultStrip, type BatchResult, type ResultFailure } from './ResultStrip';
import { SelectionBar } from './SelectionBar';

// The asset's Files tab: the file browser with the selection bar, its batch dialogs and the file detail dialog.

/** The props of the tab. */
interface Props {
  /** The asset whose files are shown. */
  asset: AssetDetail;
  /** Bumped by the host (e.g. after an import) and by `onFilesChanged`; refetches the list. */
  reloadToken: number;
  /** After any change to the asset's files: the host bumps `reloadToken` and re-reads the asset. */
  onFilesChanged(): void;
  /** Receives the updated asset after a cover change. */
  onAssetChange(asset: AssetDetail): void;
  /** The unfiltered number of files, whenever the browser shows it. */
  onCountChange(total: number): void;
}

/**
 * Detaches files one call per file, in selection order; a failure does not stop the rest.
 *
 * @param files the files to detach
 * @returns the ids of the detached files and one failure per file that was not
 */
async function unassignEach(files: readonly FileRecord[]): Promise<{ detached: string[]; failures: ResultFailure[] }> {
  const failures: ResultFailure[] = [];
  const detached: string[] = [];
  for (const file of files) {
    try {
      await call('files:unassign', { fileId: file.id });
      detached.push(file.id);
    } catch (error) {
      failures.push({ key: file.id, name: file.originalName, message: describeError(error) });
    }
  }
  return { detached, failures };
}

/**
 * The asset's files: the file browser with its own filters, view and selection (none of them
 * persisted), the selection bar (Add tags, Analyse, Set role, Detach, Delete) and the file detail
 * dialog.
 *
 * @param props the asset, the reload token and the callbacks
 * @returns the tab
 */
export function AssetFilesTab({ asset, reloadToken, onFilesChanged, onAssetChange, onCountChange }: Props) {
  const [filters, setFilters] = useState<FileFilters>(NO_FILE_FILTERS);
  const [view, setView] = useState<AssetView>('grid');
  const [selection, setSelection] = useState<FileSelection>(NO_SELECTION);
  const [dialog, setDialog] = useState<'tags' | 'role' | null>(null);
  const [batchRole, setBatchRole] = useState<FileRole>('reference');
  const [batchBusy, setBatchBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [result, setResult] = useState<BatchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const detailDialog = useFileDialog(containerRef);
  const detail = detailDialog.file;
  const studio = useStudio();
  const analysis = useAnalysisDialogs({
    onStarted: (started) => setResult({ title: enqueueTitle(started), failures: [] }),
    onChanged: onFilesChanged,
    onLeave: () => detailDialog.close(),
  });
  // Synchronous guard: a second activation before the re-render must not send a second request. One guard for
  // the single actions and the batches, so that a single delete and the selection's delete never overlap.
  const acting = useRef(false);
  const trash = useTrash();

  // The filter follows a rename in the render that raises `reloadToken`, so the browser never
  // loads the list with the old name and reloads it once, where it was.
  const { lastRename } = useTags();
  const [filtersRename, setFiltersRename] = useState(lastRename);
  if (filtersRename !== lastRename) {
    setFiltersRename(lastRename);
    if (lastRename !== null) setFilters((current) => renameInFilters(current, lastRename));
  }

  // The list reloads through `reloadToken`; the copies it does not reach follow the rename here.
  useRenamed((change) => {
    setSelection((current) => renameInSelection(current, change));
    const shown = detailDialog.file;
    if (shown !== null) detailDialog.update(renameInRecord(shown, change));
  });

  // The tab count is the unfiltered total; a filtered list (or one whose search is still pending) does not count.
  const debouncedQuery = useDebouncedValue(filters.query.trim(), SEARCH_DEBOUNCE_MS);
  const unfiltered = !hasFilters(filters) && debouncedQuery === '';

  const eligible = eligibleFiles(selection);
  const eligibleIds = eligible.map((file) => file.id);

  const openDetail = detailDialog.open;
  const closeDetail = detailDialog.close;

  /** A changed record: the dialog and the selection show it, and the list reloads. */
  function fileChanged(file: FileRecord) {
    detailDialog.update(file);
    setSelection((current) => refreshSelected(current, [file]));
    onFilesChanged();
  }

  // One cover, detach or delete action at a time; later activations while it runs are ignored.
  const setCover = (fileId: string | null) =>
    runExclusive(acting, async () => {
      onAssetChange(await call('assets:setCover', { assetId: asset.id, fileId }));
      onFilesChanged();
    });

  const detach = (file: FileRecord) =>
    runExclusive(acting, async () => {
      await call('files:unassign', { fileId: file.id });
      setSelection((current) => dropSelected(current, [file.id]));
      // The reload moves the dialog on to the file that follows (FileBrowser `viewer`).
      onFilesChanged();
    });

  const remove = (file: FileRecord) =>
    runExclusive(acting, async () => {
      const { firstError } = await runFileBatch('files:trashMany', [file]);
      throwFirst(firstError);
      setSelection((current) => dropSelected(current, [file.id]));
      // As with Detach, the reload moves the dialog on.
      onFilesChanged();
      trash.refresh();
    });

  /** For the tile menu: failures show above the list. */
  const reported = (action: () => Promise<void>) => () => {
    setError(null);
    action().catch((caught: unknown) => setError(describeError(caught)));
  };

  async function changeTags(channel: 'files:addTagMany' | 'files:removeTagMany', name: string) {
    const { items } = await call(channel, { fileIds: eligibleIds, name });
    setSelection((current) => refreshSelected(current, items));
    onFilesChanged();
  }

  /** Runs one batch at a time; it clears both errors and disables the batch buttons while it runs. */
  const batch = (action: () => Promise<void>) =>
    runExclusive(acting, action, {
      onStart: () => {
        setBatchBusy(true);
        setError(null);
        setDialogError(null);
      },
      onEnd: () => setBatchBusy(false),
    });

  // Batch answers arrive later; names come from the selection as it is then (as in the inbox).
  const latestSelection = useRef(selection);
  latestSelection.current = selection;
  const nameOf = (fileId: string) => latestSelection.current.selected.get(fileId)?.originalName ?? fileId;

  const applyRole = () =>
    batch(async () => {
      let items;
      try {
        ({ items } = await call('files:assignMany', { fileIds: eligibleIds, assetId: asset.id, role: batchRole }));
      } catch (caught) {
        setDialogError(describeError(caught));
        return;
      }
      const failures = assignFailures(items, nameOf);
      const changed = items.flatMap((item) => (item.file === null ? [] : [item.file]));
      setSelection((current) => refreshSelected(current, changed));
      setResult(batchResult(changed.length, 'updated', failures));
      setDialog(null);
      onFilesChanged();
    });

  const detachSelected = () =>
    batch(async () => {
      const { detached, failures } = await unassignEach(eligible);
      setSelection((current) => dropSelected(current, detached));
      setResult(batchResult(detached.length, 'detached', failures));
      onFilesChanged();
    });

  // All selected files, not only the eligible ones: a failed import can be deleted too.
  const deleteSelected = () =>
    batch(async () => {
      const files = [...selection.selected.values()];
      if (files.length === 0) return;
      let outcome;
      try {
        outcome = await runFileBatch('files:trashMany', files);
      } catch (caught) {
        setError(describeError(caught));
        return;
      }
      const { doneIds, failures } = outcome;
      setSelection((current) => dropSelected(current, doneIds));
      setResult(batchResult(doneIds.length, 'deleted', failures));
      onFilesChanged();
      trash.refresh();
    });

  const fileActions = (file: FileRecord) => ({
    onAnalyse: () => analysis.analyseFiles([file]),
    onReviewTags: () => analysis.review(file),
    onImageToPrompt: () => analysis.prompt(file),
    analysisBlocked: analysis.blocked,
    studio,
  });

  const coverOf = (file: FileRecord) => ({
    isEffective: file.id === asset.coverFileId,
    isChosen: asset.coverIsChosen && file.id === asset.coverFileId,
  });

  const noneEligible = eligible.length === 0;
  const openDialog = (kind: 'tags' | 'role') => {
    setDialogError(null);
    setDialog(kind);
  };

  return (
    <div ref={containerRef} className="flex min-h-0 flex-1 flex-col gap-3 pt-4">
      {error !== null && (
        <p role="alert" className={ALERT}>
          {error}
        </p>
      )}
      {result !== null && (
        <ResultStrip title={result.title} failures={result.failures} onDismiss={() => setResult(null)} />
      )}
      <SelectionBar count={selection.selected.size} onClear={() => setSelection(NO_SELECTION)}>
        <button
          type="button"
          className={BUTTON}
          disabled={noneEligible || batchBusy}
          title={noneEligible ? NONE_ELIGIBLE : undefined}
          onClick={() => openDialog('tags')}
        >
          Add tags
        </button>
        <SelectionAnalysisButtons analysis={analysis} selection={selection} />
        <button
          type="button"
          className={BUTTON}
          disabled={noneEligible || batchBusy}
          title={noneEligible ? NONE_ELIGIBLE : undefined}
          onClick={() => openDialog('role')}
        >
          Set role
        </button>
        <button
          type="button"
          className={BUTTON}
          disabled={noneEligible || batchBusy}
          title="The files are kept and move to the inbox"
          onClick={() => void detachSelected()}
        >
          Detach
        </button>
        <button
          type="button"
          className={BUTTON}
          disabled={batchBusy}
          title={DELETE_SELECTION_TITLE}
          onClick={() => void deleteSelected()}
        >
          {DELETE_LABEL}
        </button>
      </SelectionBar>
      <FileBrowser
        scope={{ kind: 'asset', assetId: asset.id }}
        filters={filters}
        onFiltersChange={setFilters}
        showRoleFilter
        view={view}
        onViewChange={setView}
        selection={selection}
        onSelectionChange={setSelection}
        reloadToken={reloadToken}
        coverFileId={asset.coverFileId}
        onOpen={openDetail}
        menuItems={(file) =>
          fileMenuItems(file, {
            cover: coverOf(file),
            onDetails: () => openDetail(file),
            onSetCover: (fileId) => reported(() => setCover(fileId))(),
            onDetach: reported(() => detach(file)),
            ...fileActions(file),
            onError: setError,
            onDelete: reported(() => remove(file)),
          })
        }
        onDeleteKey={() => {
          if (selection.selected.size > 0) void deleteSelected();
        }}
        analysis={{
          onAnalyseAll: (filter) => analysis.start({ kind: 'fileFilter', filter }),
          blocked: analysis.blocked,
        }}
        emptyText="No files"
        onTotal={(total) => {
          if (total !== null && unfiltered) onCountChange(total);
        }}
        viewer={{
          fileId: detail?.id ?? null,
          onView: (file) => (file === null ? closeDetail() : detailDialog.show(file)),
          render: (list) =>
            detail !== null && (
              <FileDetailDialog
                file={detail}
                asset={{ id: asset.id, name: asset.name, tags: asset.tags }}
                actions={{
                  cover: coverOf(detail),
                  onDetails: () => {},
                  onSetCover: setCover,
                  onDetach: () => detach(detail),
                  ...fileActions(detail),
                  onError: setError,
                  onDelete: () => remove(detail),
                }}
                roleControl={<FileRoleSelect file={detail} onChanged={fileChanged} fullWidth />}
                onFileChange={fileChanged}
                onMeasured={detailDialog.setDimensions}
                list={list}
                onClose={closeDetail}
              />
            ),
        }}
      />
      {analysis.dialogs}

      <AddTagsDialog
        open={dialog === 'tags'}
        files={eligible}
        onChangeTag={changeTags}
        onClose={() => setDialog(null)}
      />

      <SetRoleDialog
        open={dialog === 'role'}
        role={batchRole}
        onRoleChange={setBatchRole}
        busy={batchBusy}
        error={dialogError}
        onApply={() => void applyRole()}
        onClose={() => setDialog(null)}
      />
    </div>
  );
}
