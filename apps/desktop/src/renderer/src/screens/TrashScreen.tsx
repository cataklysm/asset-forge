import { useEffect, useRef, useState } from 'react';
import type { FileRecord } from '@assetforge/contracts';
import { call, describeError } from '../api';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { FileBrowser } from '../components/FileBrowser';
import { FileDetailDialog } from '../components/FileDetailDialog';
import { Page } from '../components/Page';
import { ResultStrip, type ResultFailure } from '../components/ResultStrip';
import { SelectionBar } from '../components/SelectionBar';
import { fileMenuItems } from '../file-actions';
import { useFileDialog } from '../hooks/useFileDialog';
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
import { runFileBatch, throwFirst } from '../trash-actions';
import { useTrash } from '../trash-context';
import { ALERT, BUTTON } from '../ui';

export type { TrashListState } from '../list-state';

const TRASH = { kind: 'trash' } as const;

/** Hands the outcome of a confirmation back to the one that asked (the detail dialog). */
interface Settle {
  resolve(): void;
  reject(error: unknown): void;
}

/**
 * What the open confirmation will do. A purge with `settle` reports its failure there instead of
 * in the screen's strip or alert, which the full-window viewer covers.
 */
type Pending = { kind: 'purge'; files: FileRecord[]; settle?: Settle } | { kind: 'empty'; total: number };

interface Props {
  /** Filters and scroll offset; kept by the shell so that they survive navigation. */
  state: TrashListState;
  onStateChange(s: TrashListState): void;
}

/**
 * The trash: deleted files, newest deletion first, with their deletion date and origin. Restore
 * puts files back at once; Delete permanently and Empty trash ask first. One action at a time.
 * The selection is local and does not survive navigation.
 */
export function TrashScreen({ state, onStateChange }: Props) {
  const [view, setView] = useState<AssetView>('grid');
  const [selection, setSelection] = useState<FileSelection>(NO_SELECTION);
  const [reloadToken, setReloadToken] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ title: string; failures: ResultFailure[] } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const positionRef = useRef<ViewPosition | null>(null);
  const detail = useFileDialog(containerRef);
  const trash = useTrash();
  // Synchronous guard: a second activation before the re-render must not send a second request.
  const acting = useRef(false);

  // The title and Empty trash use the number of all files in the trash, independent of the filters.
  const all = useLoad(() => call('files:list', { limit: 1, offset: 0, scope: TRASH }), [reloadToken]);
  const total = all.data?.total ?? null;

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

  function setFilters(filters: FileFilters) {
    onStateChange({ ...state, filters, scrollOffset: 0 });
  }

  /** Runs one action at a time; later activations while it runs are ignored. */
  async function exclusive(action: () => Promise<void>): Promise<void> {
    if (acting.current) return;
    acting.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
    } finally {
      acting.current = false;
      setBusy(false);
    }
  }

  /** Files that left the trash: out of the selection; the list (the dialog moves on) and the count reload. */
  function left(ids: readonly string[]) {
    setSelection((current) => dropSelected(current, ids));
    setReloadToken((t) => t + 1);
    trash.refresh();
  }

  /** One file back (menu, dialog). A failure rejects for the caller to show. */
  const restoreOne = (file: FileRecord) =>
    exclusive(async () => {
      const { doneIds, failures } = await runFileBatch('files:restoreMany', [file]);
      left(doneIds);
      throwFirst(failures);
    });

  const restoreSelected = () =>
    exclusive(async () => {
      try {
        const { doneIds, failures } = await runFileBatch('files:restoreMany', [...selection.selected.values()]);
        setResult(failures.length === 0 ? null : { title: `${doneIds.length} restored, ${failures.length} failed`, failures });
        left(doneIds);
      } catch (e) {
        setError(describeError(e));
      }
    });

  function askPurge(files: FileRecord[]) {
    if (files.length === 0 || acting.current) return;
    setPending({ kind: 'purge', files });
  }

  /** Delete permanently from the dialog: settles when the confirmation ends and rejects with a failure. */
  function askPurgeFromDialog(file: FileRecord): Promise<void> {
    if (acting.current) return Promise.resolve();
    return new Promise((resolve, reject) => setPending({ kind: 'purge', files: [file], settle: { resolve, reject } }));
  }

  function cancel() {
    if (pending?.kind === 'purge') pending.settle?.resolve();
    setPending(null);
  }

  const confirmed = (action: Pending) =>
    exclusive(async () => {
      try {
        if (action.kind === 'purge' && action.settle !== undefined) {
          const { doneIds, failures } = await runFileBatch('files:purgeMany', action.files);
          left(doneIds);
          throwFirst(failures);
          action.settle.resolve();
        } else if (action.kind === 'purge') {
          const { doneIds, failures } = await runFileBatch('files:purgeMany', action.files);
          setResult(failures.length === 0 ? null : { title: `${doneIds.length} deleted, ${failures.length} failed`, failures });
          left(doneIds);
        } else {
          const { purged, failed } = await call('trash:empty', {});
          setResult(failed === 0 ? null : { title: `${purged} deleted, ${failed} failed`, failures: [] });
          setSelection(NO_SELECTION);
          left([]);
        }
      } catch (e) {
        if (action.kind === 'purge' && action.settle !== undefined) action.settle.reject(e);
        else setError(describeError(e));
      } finally {
        setPending(null);
      }
    });

  /** For the tile menu: failures show above the list. */
  const reported = (action: () => Promise<void>) => () => {
    setError(null);
    action().catch((e: unknown) => setError(describeError(e)));
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
          onClick={() => total !== null && setPending({ kind: 'empty', total })}
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
        {result !== null && <ResultStrip title={result.title} failures={result.failures} onDismiss={() => setResult(null)} />}
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
          <button type="button" className={BUTTON} disabled={busy} title={PURGE_SELECTION_TITLE} onClick={() => askPurge(selected)}>
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
          reloadToken={reloadToken}
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
                    onDetails: () => {},
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
          title={
            pending === null ? '' : purgeConfirmTitle(pending.kind === 'purge' ? pending.files.length : pending.total)
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
