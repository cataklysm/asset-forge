import { useEffect, useState } from 'react';
import type { FileRecord, FileRole, ImportResult } from '@assetforge/contracts';
import { FileRoleSchema } from '@assetforge/contracts';
import { call, describeError } from '../api';
import { AssetPicker } from '../components/AssetPicker';
import { Pager } from '../components/Pager';
import { formatBytes, formatDateTime } from '../format';
import { useLoad } from '../hooks/useLoad';
import { label } from '../labels';
import { ALERT, BORDER, BUTTON, INPUT, MUTED } from '../ui';

const PAGE_SIZE = 50;
const ROLES = FileRoleSchema.options;

/** The inbox: imported files that are not placed in an asset yet. */
export function FilesScreen({ onBusyChange }: { onBusyChange?(busy: boolean): void }) {
  const [offset, setOffset] = useState(0);
  const [importing, setImporting] = useState(false);
  const [results, setResults] = useState<ImportResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [assigning, setAssigning] = useState<string | null>(null);
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
      else setOffset(0);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setImporting(false);
    }
  }

  async function assign(file: FileRecord, assetId: string) {
    setError(null);
    try {
      await call('files:assign', { fileId: file.id, assetId, role });
      setAssigning(null);
      list.reload();
    } catch (e) {
      setError(describeError(e));
    }
  }

  const failed = results?.filter((result) => result.error !== null) ?? [];
  // A duplicate is still imported (it only has matching content), so it counts in both figures.
  const duplicates = results?.filter((result) => result.duplicateOf.length > 0).length ?? 0;
  const imported = results?.filter((result) => result.file !== null).length ?? 0;
  const data = list.data;

  return (
    <section className="space-y-4" aria-label="Inbox">
      <div className="flex items-center gap-3">
        <button
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
          <table className="w-full text-left text-sm">
            <thead className={`border-b ${BORDER} ${MUTED}`}>
              <tr>
                <th className="py-1 pr-3">Name</th>
                <th className="py-1 pr-3">Type</th>
                <th className="py-1 pr-3">Size</th>
                <th className="py-1 pr-3">Status</th>
                <th className="py-1 pr-3">Imported</th>
                <th className="py-1" />
              </tr>
            </thead>
            <tbody>
              {data.items.map((file) => (
                <tr key={file.id} className={`border-b ${BORDER} align-top`}>
                  <td className="py-1 pr-3">{file.originalName}</td>
                  <td className="py-1 pr-3">{file.mimeType}</td>
                  <td className="py-1 pr-3">{formatBytes(file.sizeBytes)}</td>
                  <td className="py-1 pr-3">{label(file.status)}</td>
                  <td className="py-1 pr-3">{formatDateTime(file.importedAt)}</td>
                  <td className="py-1">
                    {file.status === 'complete' &&
                      (assigning === file.id ? (
                        <div className="space-y-2">
                          <select
                            className={INPUT}
                            aria-label="Role"
                            value={role}
                            onChange={(e) => setRole(FileRoleSchema.parse(e.target.value))}
                          >
                            {ROLES.map((r) => (
                              <option key={r} value={r}>
                                {label(r)}
                              </option>
                            ))}
                          </select>
                          <AssetPicker onPick={(asset) => assign(file, asset.id)} />
                        </div>
                      ) : (
                        <button
                          type="button"
                          className={BUTTON}
                          onClick={() => setAssigning(file.id)}
                        >
                          Assign
                        </button>
                      ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.total === 0 && <p className={MUTED}>No files yet.</p>}
          <Pager offset={offset} limit={PAGE_SIZE} total={data.total} onChange={setOffset} />
        </>
      )}
    </section>
  );
}
