import { useEffect, useRef, useState } from 'react';
import { FileRoleSchema, type AssetDetail, type FileRecord, type FileRole } from '@assetforge/contracts';
import { ApiError, call, describeError } from '../api';
import { fileMenuItems } from '../file-actions';
import { SEARCH_DEBOUNCE_MS, useDebouncedValue } from '../hooks/useDebouncedValue';
import { label } from '../labels';
import { hasFilters, NO_FILE_FILTERS, type AssetView, type FileFilters } from '../list-state';
import { dropSelected, eligibleFiles, NO_SELECTION, refreshSelected, sharedTags, type FileSelection } from '../selection';
import { ALERT, BUTTON, SELECT } from '../ui';
import { Dialog } from './Dialog';
import { FileBrowser } from './FileBrowser';
import { FileDetailDialog } from './FileDetailDialog';
import { FileRoleSelect } from './FileRoleControls';
import { ResultStrip, type ResultFailure } from './ResultStrip';
import { SelectionBar } from './SelectionBar';
import { TagRow } from './TagRow';

const ROLES = FileRoleSchema.options;
const NONE_ELIGIBLE = 'None of the selected files is completely imported';

interface Props {
  asset: AssetDetail;
  /** Bumped by the host (e.g. after an import) and by `onFilesChanged`; refetches the list. */
  reloadToken: number;
  /** After any change to the asset's files: the host bumps `reloadToken` and re-reads the asset. */
  onFilesChanged(): void;
  onAssetChange(asset: AssetDetail): void;
  /** The unfiltered number of files, whenever the browser shows it. */
  onCountChange(total: number): void;
}

interface Opened {
  id: string;
  trigger: HTMLElement | null;
}

/**
 * The asset's files: the file browser with its own filters, view and selection (none of them
 * persisted), the selection bar (Add tags, Set role, Detach) and the file detail dialog.
 */
export function AssetFilesTab({ asset, reloadToken, onFilesChanged, onAssetChange, onCountChange }: Props) {
  const [filters, setFilters] = useState<FileFilters>(NO_FILE_FILTERS);
  const [view, setView] = useState<AssetView>('grid');
  const [selection, setSelection] = useState<FileSelection>(NO_SELECTION);
  const [detail, setDetail] = useState<FileRecord | null>(null);
  const [dialog, setDialog] = useState<'tags' | 'role' | null>(null);
  const [batchRole, setBatchRole] = useState<FileRole>('reference');
  const [batchBusy, setBatchBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [result, setResult] = useState<{ title: string; failures: ResultFailure[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const opened = useRef<Opened | null>(null);
  const pendingFocus = useRef<Opened | null>(null);
  // Synchronous guards: a second activation before the re-render must not send a second request.
  const acting = useRef(false);
  const batching = useRef(false);

  // The tab count is the unfiltered total; a filtered list (or one whose search is still pending) does not count.
  const debouncedQuery = useDebouncedValue(filters.query.trim(), SEARCH_DEBOUNCE_MS);
  const unfiltered = !hasFilters(filters) && debouncedQuery === '';

  const eligible = eligibleFiles(selection);
  const eligibleIds = eligible.map((f) => f.id);

  function openDetail(file: FileRecord) {
    const active = document.activeElement;
    opened.current = { id: file.id, trigger: active instanceof HTMLElement ? active : null };
    setDetail(file);
  }

  function closeDetail() {
    pendingFocus.current = opened.current;
    opened.current = null;
    setDetail(null);
  }

  // After the dialog has gone: the opener, else the same file's element (the list may have been
  // reloaded while the dialog was open), else the first tile.
  useEffect(() => {
    const target = pendingFocus.current;
    if (detail !== null || target === null) return;
    pendingFocus.current = null;
    if (target.trigger?.isConnected) {
      target.trigger.focus();
      return;
    }
    const root = containerRef.current;
    const element =
      root?.querySelector<HTMLElement>(`[data-file-id="${CSS.escape(target.id)}"]`) ??
      root?.querySelector<HTMLElement>('[data-file-tile]');
    element?.focus();
  }, [detail]);

  /** A changed record: the dialog and the selection show it, and the list reloads. */
  function fileChanged(file: FileRecord) {
    setDetail((current) => (current?.id === file.id ? file : current));
    setSelection((current) => refreshSelected(current, [file]));
    onFilesChanged();
  }

  /** Runs one cover or detach action at a time; later activations while it runs are ignored. */
  async function exclusive(action: () => Promise<void>): Promise<void> {
    if (acting.current) return;
    acting.current = true;
    try {
      await action();
    } finally {
      acting.current = false;
    }
  }

  const setCover = (fileId: string | null) =>
    exclusive(async () => {
      onAssetChange(await call('assets:setCover', { assetId: asset.id, fileId }));
      onFilesChanged();
    });

  const detach = (file: FileRecord) =>
    exclusive(async () => {
      await call('files:unassign', { fileId: file.id });
      setSelection((current) => dropSelected(current, [file.id]));
      if (opened.current?.id === file.id) closeDetail();
      onFilesChanged();
    });

  /** For the tile menu: failures show above the list. */
  const reported = (action: () => Promise<void>) => () => {
    setError(null);
    action().catch((e: unknown) => setError(describeError(e)));
  };

  async function changeTags(channel: 'files:addTagMany' | 'files:removeTagMany', name: string) {
    const { items } = await call(channel, { fileIds: eligibleIds, name });
    setSelection((current) => refreshSelected(current, items));
    onFilesChanged();
  }

  async function batch(action: () => Promise<void>) {
    if (batching.current) return;
    batching.current = true;
    setBatchBusy(true);
    setError(null);
    setDialogError(null);
    try {
      await action();
    } finally {
      batching.current = false;
      setBatchBusy(false);
    }
  }

  const nameOf = (fileId: string) => selection.selected.get(fileId)?.originalName ?? fileId;

  const applyRole = () =>
    batch(async () => {
      let items;
      try {
        ({ items } = await call('files:assignMany', { fileIds: eligibleIds, assetId: asset.id, role: batchRole }));
      } catch (e) {
        setDialogError(describeError(e));
        return;
      }
      const failures = items.flatMap((item) =>
        item.error === null
          ? []
          : [{ key: item.fileId, name: nameOf(item.fileId), message: describeError(new ApiError(item.error.code, item.error.message)) }],
      );
      const changed = items.flatMap((item) => (item.file === null ? [] : [item.file]));
      setSelection((current) => refreshSelected(current, changed));
      setResult(failures.length === 0 ? null : { title: `${changed.length} updated, ${failures.length} failed`, failures });
      setDialog(null);
      onFilesChanged();
    });

  // One call per file, in selection order (a failure does not stop the rest).
  const detachSelected = () =>
    batch(async () => {
      const files = eligible;
      const failures: ResultFailure[] = [];
      const detached: string[] = [];
      for (const file of files) {
        try {
          await call('files:unassign', { fileId: file.id });
          detached.push(file.id);
        } catch (e) {
          failures.push({ key: file.id, name: file.originalName, message: describeError(e) });
        }
      }
      setSelection((current) => dropSelected(current, detached));
      setResult(failures.length === 0 ? null : { title: `${detached.length} detached, ${failures.length} failed`, failures });
      onFilesChanged();
    });

  const coverOf = (file: FileRecord) => ({
    isEffective: file.id === asset.coverFileId,
    isChosen: asset.coverIsChosen && file.id === asset.coverFileId,
  });

  const noneEligible = eligible.length === 0;

  return (
    <div ref={containerRef} className="flex min-h-0 flex-1 flex-col gap-3 pt-4">
      {error !== null && (
        <p role="alert" className={ALERT}>
          {error}
        </p>
      )}
      {result !== null && <ResultStrip title={result.title} failures={result.failures} onDismiss={() => setResult(null)} />}
      <SelectionBar count={selection.selected.size} onClear={() => setSelection(NO_SELECTION)}>
        <button
          type="button"
          className={BUTTON}
          disabled={noneEligible || batchBusy}
          title={noneEligible ? NONE_ELIGIBLE : undefined}
          onClick={() => {
            setDialogError(null);
            setDialog('tags');
          }}
        >
          Add tags
        </button>
        <button
          type="button"
          className={BUTTON}
          disabled={noneEligible || batchBusy}
          title={noneEligible ? NONE_ELIGIBLE : undefined}
          onClick={() => {
            setDialogError(null);
            setDialog('role');
          }}
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
            onError: setError,
          })
        }
        emptyText="No files"
        onTotal={(total) => {
          if (total !== null && unfiltered) onCountChange(total);
        }}
      />

      <Dialog open={dialog === 'tags'} title="Add tags" onClose={() => setDialog(null)}>
        <div className="space-y-4">
          <TagRow
            label="Image tags"
            kind="file"
            tags={sharedTags(eligible)}
            onAdd={(name) => changeTags('files:addTagMany', name)}
            onRemove={(name) => changeTags('files:removeTagMany', name)}
          />
          <div className="flex justify-end">
            <button type="button" className={BUTTON} onClick={() => setDialog(null)}>
              Done
            </button>
          </div>
        </div>
      </Dialog>

      <Dialog open={dialog === 'role'} title="Set role" onClose={() => setDialog(null)}>
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <select
              className={SELECT}
              aria-label="Role"
              value={batchRole}
              onChange={(e) => setBatchRole(FileRoleSchema.parse(e.target.value))}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {label(r)}
                </option>
              ))}
            </select>
            <button type="button" className={BUTTON} disabled={batchBusy} onClick={() => void applyRole()}>
              Apply
            </button>
            <button type="button" className={BUTTON} onClick={() => setDialog(null)}>
              Cancel
            </button>
          </div>
          {dialogError !== null && (
            <p role="alert" className={ALERT}>
              {dialogError}
            </p>
          )}
        </div>
      </Dialog>

      {detail !== null && (
        <FileDetailDialog
          file={detail}
          asset={{ id: asset.id, name: asset.name, tags: asset.tags }}
          actions={{
            cover: coverOf(detail),
            onDetails: () => {},
            onSetCover: setCover,
            onDetach: () => detach(detail),
            onError: setError,
          }}
          roleControl={<FileRoleSelect file={detail} onChanged={fileChanged} />}
          onFileChange={fileChanged}
          onClose={closeDetail}
        />
      )}
    </div>
  );
}
