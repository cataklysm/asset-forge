import { useRef, useState } from 'react';
import type { FileRecord } from '@assetforge/contracts';
import { call, describeError } from '../api';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { FileBrowser } from '../components/FileBrowser';
import { FileDetailDialog } from '../components/FileDetailDialog';
import { Page } from '../components/Page';
import { batchResult, ResultStrip, type BatchResult } from '../components/ResultStrip';
import { SelectionBar } from '../components/SelectionBar';
import { runExclusive } from '../exclusive';
import { fileMenuItems } from '../file-actions';
import { useFileDialog } from '../hooks/useFileDialog';
import { useKeptScrollOffset } from '../hooks/useKeptScrollOffset';
import { useLoad } from '../hooks/useLoad';
import type { ViewPosition } from '../hooks/useVirtualRows';
import {
  EMPTY_TRASH_LABEL,
  EMPTY_TRASH_TITLE,
  PURGE_LABEL,
  PURGE_SELECTION_TITLE,
  purgeConfirmTitle,
  RESTORE_LABEL,
  RESTORE_SELECTION_TITLE,
  TRASH_EMPTY_TEXT,
  TRASH_LABEL,
} from '../labels';
import type { AssetView, FileFilters, TrashListState } from '../list-state';
import { dropSelected, NO_SELECTION, refreshSelected, type FileSelection } from '../selection';
import { renameInRecord, renameInSelection } from '../tag-rename';
import { useRenamed, useTags } from '../tags-context';
import { runFileBatch, throwFirst } from '../trash-actions';
import { useTrash } from '../trash-context';
import { ALERT, BUTTON } from '../ui';

export type { TrashListState } from '../list-state';

// The trash screen: deleted files with Restore, Delete permanently and Empty trash.

const TRASH = { kind: 'trash' } as const;

/** Hands the outcome of a confirmation back to the one that asked (the detail dialog). */
interface Settle {
  /** The confirmation ended without a failure, or was cancelled. */
  resolve(): void;
  /** The confirmed action failed. */
  reject(error: unknown): void;
}

/**
 * What the open confirmation will do. A purge with `settle` reports its failure there instead of
 * in the screen's strip or alert, which the full-window viewer covers.
 */
type Pending = { kind: 'purge'; files: FileRecord[]; settle?: Settle } | { kind: 'empty' };

/** The props of the trash screen. */
interface Props {
  /** Filters and scroll offset; kept by the shell so that they survive navigation. */
  state: TrashListState;
  /** Hands changed filters or the kept scroll offset to the shell. */
  onStateChange(state: TrashListState): void;
}

/**
 * The trash: deleted files, newest deletion first, with their deletion date and origin. Restore
 * puts files back at once; Delete permanently and Empty trash ask first. One action at a time.
 * The selection is local and does not survive navigation.
 *
 * @param props the kept list state and its change
 * @returns the screen
 */
export function TrashScreen({ state, onStateChange }: Props) {
  const [view, setView] = useState<AssetView>('grid');
  const [selection, setSelection] = useState<FileSelection>(NO_SELECTION);
  const [reloadToken, setReloadToken] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BatchResult | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const positionRef = useRef<ViewPosition | null>(null);
  const detail = useFileDialog(containerRef);
  const trash = useTrash();
  // Synchronous guard: a second activation before the re-render must not send a second request.
  const acting = useRef(false);

  // A tag rename reloads the list; the selection and the shown file are copies it does not reach.
  const { renameToken } = useTags();
  useRenamed((change) => {
    setSelection((current) => renameInSelection(current, change));
    const shown = detail.file;
    if (shown !== null) detail.update(renameInRecord(shown, change));
  });

  // The title and Empty trash use the number of all files in the trash, independent of the filters.
  const all = useLoad(() => call('files:list', { limit: 1, offset: 0, scope: TRASH }), [reloadToken]);
  const total = all.data?.total ?? null;

  // Leaving the screen keeps the filters (already in `state`) and the scroll offset.
  useKeptScrollOffset(positionRef, state, onStateChange);

  /** New filters start the list at the top. */
  function setFilters(filters: FileFilters) {
    onStateChange({ ...state, filters, scrollOffset: 0 });
  }

  /** Runs one action at a time; later activations while it runs are ignored. */
  const exclusive = (action: () => Promise<void>): Promise<void> =>
    runExclusive(acting, action, {
      onStart: () => {
        setBusy(true);
        setError(null);
      },
      onEnd: () => setBusy(false),
    });

  /** Files that left the trash: out of the selection; the list (the dialog moves on) and the count reload. */
  function left(ids: readonly string[]) {
    setSelection((current) => dropSelected(current, ids));
    setReloadToken((token) => token + 1);
    trash.refresh();
  }

  /** One file back (menu, dialog). A failure rejects for the caller to show. */
  const restoreOne = (file: FileRecord) =>
    exclusive(async () => {
      const { doneIds, firstError } = await runFileBatch('files:restoreMany', [file]);
      left(doneIds);
      throwFirst(firstError);
    });

  const restoreSelected = () =>
    exclusive(async () => {
      try {
        const { doneIds, failures } = await runFileBatch('files:restoreMany', [...selection.selected.values()]);
        setResult(batchResult(doneIds.length, 'restored', failures));
        left(doneIds);
      } catch (caught) {
        setError(describeError(caught));
      }
    });

  /** Asks before the files are deleted permanently; nothing while an action runs. */
  function askPurge(files: FileRecord[]) {
    if (files.length === 0 || acting.current) return;
    setPending({ kind: 'purge', files });
  }

  /** Delete permanently from the dialog: settles when the confirmation ends and rejects with a failure. */
  function askPurgeFromDialog(file: FileRecord): Promise<void> {
    if (acting.current) return Promise.resolve();
    return new Promise((resolve, reject) => setPending({ kind: 'purge', files: [file], settle: { resolve, reject } }));
  }

  /** Ends the confirmation without acting; a dialog that asked is told it settled. */
  function cancel() {
    if (pending?.kind === 'purge') pending.settle?.resolve();
    setPending(null);
  }

  /**
   * Carries out a confirmed action. A purge for the dialog rejects with the first failure; any other purge and
   * Empty trash show their failures in the strip.
   */
  async function carryOut(action: Pending): Promise<void> {
    if (action.kind === 'empty') {
      const { purged, failed } = await call('trash:empty', {});
      setResult(failed === 0 ? null : { title: `${purged} deleted, ${failed} failed`, failures: [] });
      setSelection(NO_SELECTION);
      left([]);
      return;
    }
    const { doneIds, failures, firstError } = await runFileBatch('files:purgeMany', action.files);
    if (action.settle !== undefined) {
      left(doneIds);
      throwFirst(firstError);
      action.settle.resolve();
    } else {
      setResult(batchResult(doneIds.length, 'deleted', failures));
      left(doneIds);
    }
  }

  /** The confirmation's OK: one action at a time; a failure goes to the dialog that asked, else to the alert. */
  const confirmed = (action: Pending) =>
    exclusive(async () => {
      try {
        await carryOut(action);
      } catch (caught) {
        if (action.kind === 'purge' && action.settle !== undefined) action.settle.reject(caught);
        else setError(describeError(caught));
      } finally {
        setPending(null);
      }
    });

  /** For the tile menu: failures show above the list. */
  const reported = (action: () => Promise<void>) => () => {
    setError(null);
    action().catch((caught: unknown) => setError(describeError(caught)));
  };

  const shown = detail.file;
  const selected = [...selection.selected.values()];

  return (
    <Page
      title={TRASH_LABEL}
      count={total}
      countTitle="Files in the trash"
      actions={
        <button
          type="button"
          className={BUTTON}
          disabled={total === null || total === 0 || busy}
          title={EMPTY_TRASH_TITLE}
          onClick={() => setPending({ kind: 'empty' })}
        >
          {EMPTY_TRASH_LABEL}
        </button>
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
            disabled={busy}
            title={RESTORE_SELECTION_TITLE}
            onClick={() => void restoreSelected()}
          >
            {RESTORE_LABEL}
          </button>
          <button
            type="button"
            className={BUTTON}
            disabled={busy}
            title={PURGE_SELECTION_TITLE}
            onClick={() => askPurge(selected)}
          >
            {PURGE_LABEL}
          </button>
        </SelectionBar>
        <FileBrowser
          scope={TRASH}
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
              onRestore: reported(() => restoreOne(file)),
              onPurge: () => askPurge([file]),
              onError: setError,
            })
          }
          onDeleteKey={() => askPurge(selected)}
          emptyText={TRASH_EMPTY_TEXT}
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
                    onRestore: () => restoreOne(shown),
                    onPurge: () => askPurgeFromDialog(shown),
                    onError: setError,
                  }}
                  roleControl={null}
                  onFileChange={(file) => {
                    detail.update(file);
                    setSelection((current) => refreshSelected(current, [file]));
                  }}
                  onMeasured={detail.setDimensions}
                  list={list}
                  onClose={detail.close}
                />
              ),
          }}
        />
        <ConfirmDialog
          open={pending !== null}
          // Empty trash names the count as it is now: a reload that answers while the dialog is open updates it.
          title={
            pending === null ? '' : purgeConfirmTitle(pending.kind === 'purge' ? pending.files.length : (total ?? 0))
          }
          confirmLabel={pending?.kind === 'empty' ? EMPTY_TRASH_LABEL : PURGE_LABEL}
          busy={busy}
          onConfirm={() => pending !== null && void confirmed(pending)}
          onCancel={cancel}
        />
      </div>
    </Page>
  );
}
