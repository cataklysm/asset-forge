import { useEffect, useRef, useState } from 'react';
import type { FileRecord, FileRole, ImportResult } from '@assetforge/contracts';
import { FileRoleSchema } from '@assetforge/contracts';
import { call, describeError } from '../api';
import { FileDetailDialog } from '../components/FileDetailDialog';
import { AssignFileControl } from '../components/FileRoleControls';
import { FileGrid } from '../components/FileGrid';
import { Pager } from '../components/Pager';
import { useFileDetail } from '../components/useFileDetail';
import { useLoad } from '../hooks/useLoad';
import { label } from '../labels';
import { ALERT, BUTTON, INPUT, MUTED } from '../ui';

const PAGE_SIZE = 50;
const ROLES = FileRoleSchema.options;

/** The inbox: imported files that are not placed in an asset yet. */
interface Props {
  offset: number;
  onOffsetChange(offset: number): void;
  onBusyChange?(busy: boolean): void;
}

export function FilesScreen({ offset, onOffsetChange, onBusyChange }: Props) {
  const [importing, setImporting] = useState(false);
  const [results, setResults] = useState<ImportResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [role, setRole] = useState<FileRole>('reference');
  const list = useLoad(
    () => call('files:list', { limit: PAGE_SIZE, offset, scope: { kind: 'inbox' } }),
    [offset],
  );

  useEffect(() => {
    onBusyChange?.(importing);
    return () => onBusyChange?.(false);
  }, [importing, onBusyChange]);

  async function importFiles() {
    setError(null);
    setImporting(true);
    try {
      const sourcePaths = await call('dialog:pickFiles', {});
      if (sourcePaths.length === 0) return;
      setResults(await call('files:import', { sourcePaths }));
      if (offset === 0) list.reload();
      else onOffsetChange(0);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setImporting(false);
    }
  }

  const failed = results?.filter((result) => result.error !== null) ?? [];
  // A duplicate is still imported (it only has matching content), so it counts in both figures.
  const duplicates = results?.filter((result) => result.duplicateOf.length > 0).length ?? 0;
  const imported = results?.filter((result) => result.file !== null).length ?? 0;
  const data = list.data;
  const gridSection = useRef<HTMLElement>(null);
  const importButton = useRef<HTMLButtonElement>(null);
  const detail = useFileDetail(data?.items ?? null, gridSection, importButton);

  return (
    <section className="space-y-4" aria-label="Inbox" ref={gridSection}>
      <div className="flex items-center gap-3">
        <button
          ref={importButton}
          type="button"
          className={BUTTON}
          disabled={importing}
          onClick={() => void importFiles()}
        >
          Import files
        </button>
        {importing && <span className={`text-sm ${MUTED}`}>Importing…</span>}
      </div>

      {error !== null && (
        <p role="alert" className={ALERT}>
          {error}
        </p>
      )}
      {list.error !== null && (
        <p role="alert" className={ALERT}>
          {list.error}
        </p>
      )}

      {results !== null && (
        <div className="space-y-1">
          <p>
            {imported} imported, {failed.length} failed, {duplicates} duplicates
          </p>
          {failed.length > 0 && (
            <ul className="list-disc pl-5 text-sm text-red-800 dark:text-red-300">
              {failed.map((result) => (
                <li key={result.file?.id ?? result.sourcePath}>
                  {result.sourcePath}: {result.error}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {data === null ? (
        list.error === null && <p className={MUTED}>Loading…</p>
      ) : (
        <>
          <FileGrid files={data.items} coverFileId={null} onSelect={detail.select} />
          {detail.file !== null && (
            <FileDetailDialog
              file={detail.file}
              asset={null}
              actions={{ cover: null, onDetails: () => {} }}
              roleControl={<AssignFileControl file={detail.file} onAssigned={list.reload} />}
              onFileChange={() => list.reload()}
              onClose={detail.close}
            />
          )}
          {data.total === 0 && <p className={MUTED}>No files yet.</p>}
          <Pager offset={offset} limit={PAGE_SIZE} total={data.total} onChange={onOffsetChange} />
        </>
      )}
    </section>
  );
}
