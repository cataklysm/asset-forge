import { useEffect, useState } from 'react';
import {
  AssetStatusSchema,
  FileRoleSchema,
  RelationKindSchema,
  type FileRecord,
  type FileRole,
  type ImportResult,
  type RelationKind,
} from '@assetforge/contracts';
import { call, describeError } from '../api';
import { AssetPicker } from '../components/AssetPicker';
import { AssignmentFields } from '../components/AssignmentFields';
import { CommitInput } from '../components/CommitInput';
import { Pager } from '../components/Pager';
import { formatBytes } from '../format';
import { useLoad } from '../hooks/useLoad';
import { label, relationLabel } from '../labels';
import type { View } from '../nav';
import { ALERT, BORDER, BUTTON, INPUT, MUTED } from '../ui';

const PAGE_SIZE = 50;
const ROLES = FileRoleSchema.options;

interface Props {
  id: string;
  onNavigate(view: View): void;
  onBusyChange?(busy: boolean): void;
}

export function AssetScreen({ id, onNavigate, onBusyChange }: Props) {
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [projectToAdd, setProjectToAdd] = useState('');
  const [importRole, setImportRole] = useState<FileRole>('reference');
  const [relationKind, setRelationKind] = useState<RelationKind>('uses');
  const [importing, setImporting] = useState(false);
  const [results, setResults] = useState<ImportResult[] | null>(null);

  const asset = useLoad(() => call('assets:get', { id }), [id]);
  const types = useLoad(() => call('assetTypes:list', {}), []);
  const assignments = useLoad(() => call('assignments:listByAsset', { assetId: id }), [id]);
  const projects = useLoad(() => call('projects:list', { limit: 200, offset: 0 }), []);
  const relations = useLoad(() => call('relations:list', { assetId: id }), [id]);
  const files = useLoad(
    () => call('files:list', { limit: PAGE_SIZE, offset, scope: { kind: 'asset', assetId: id } }),
    [id, offset],
  );

  useEffect(() => {
    onBusyChange?.(importing);
    return () => onBusyChange?.(false);
  }, [importing, onBusyChange]);

  /** Runs a mutation; shows its error and reports whether it succeeded. */
  async function run(action: () => Promise<unknown>): Promise<boolean> {
    setError(null);
    try {
      await action();
      return true;
    } catch (e) {
      setError(describeError(e));
      return false;
    }
  }

  const saveAsset = (patch: Parameters<typeof call<'assets:update'>>[1]['patch']) =>
    run(async () => {
      await call('assets:update', { id, patch });
      asset.reload();
    });

  async function importFiles() {
    setError(null);
    setImporting(true);
    try {
      const sourcePaths = await call('dialog:pickFiles', {});
      if (sourcePaths.length === 0) return;
      setResults(
        await call('files:import', { sourcePaths, target: { assetId: id, role: importRole } }),
      );
      if (offset === 0) files.reload();
      else setOffset(0);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setImporting(false);
    }
  }

  const data = asset.data;
  const typeItems = types.data ?? [];
  const assigned = assignments.data ?? [];
  const assignedIds = new Set(assigned.map((a) => a.projectId));
  const unassigned = (projects.data?.items ?? []).filter((p) => !assignedIds.has(p.id));
  const effectiveProject = unassigned.some((p) => p.id === projectToAdd)
    ? projectToAdd
    : (unassigned[0]?.id ?? '');

  const fileItems = files.data?.items ?? [];
  const groups = ROLES.map((role) => ({
    role,
    items: fileItems.filter((f) => f.role === role),
  })).filter((g) => g.items.length > 0);

  const loadErrors = [asset, types, assignments, projects, relations, files]
    .map((l) => l.error)
    .filter((e): e is string => e !== null);

  const failed = results?.filter((r) => r.error !== null) ?? [];
  const imported = results?.filter((r) => r.file !== null && r.error === null).length ?? 0;

  function fileRow(file: FileRecord) {
    return (
      <tr key={file.id} className={`border-b ${BORDER}`}>
        <td className="py-1 pr-3">{file.originalName}</td>
        <td className="py-1 pr-3">{formatBytes(file.sizeBytes)}</td>
        <td className="py-1 pr-3">{file.status !== 'complete' ? label(file.status) : ''}</td>
        <td className="py-1 pr-3">
          <select
            className={INPUT}
            aria-label={`Role of ${file.originalName}`}
            value={file.role ?? 'other'}
            onChange={(e) =>
              void run(async () => {
                await call('files:assign', {
                  fileId: file.id,
                  assetId: id,
                  role: FileRoleSchema.parse(e.target.value),
                });
                files.reload();
              })
            }
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {label(r)}
              </option>
            ))}
          </select>
        </td>
        <td className="py-1">
          <button
            type="button"
            className={BUTTON}
            aria-label={`Detach ${file.originalName} from ${data?.name ?? 'asset'}`}
            title="The file is kept and moves to the inbox"
            onClick={() =>
              void run(async () => {
                await call('files:unassign', { fileId: file.id });
                files.reload();
              })
            }
          >
            Detach
          </button>
        </td>
      </tr>
    );
  }

  return (
    <section className="space-y-6" aria-label="Asset">
      <div>
        <button
          type="button"
          className={BUTTON}
          disabled={importing}
          title={importing ? 'Import in progress' : undefined}
          onClick={() => onNavigate({ name: 'assets' })}
        >
          Back
        </button>
      </div>

      {error !== null && (
        <p role="alert" className={ALERT}>
          {error}
        </p>
      )}
      {loadErrors.map((message) => (
        <p key={message} role="alert" className={ALERT}>
          {message}
        </p>
      ))}

      {data === null ? (
        asset.error === null && <p className={MUTED}>Loading…</p>
      ) : (
        <>
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <CommitInput
                label="Name"
                value={data.name}
                maxLength={200}
                onCommit={(name) => saveAsset({ name })}
              />
              <select
                className={INPUT}
                aria-label="Type"
                value={data.typeId}
                onChange={(e) => void saveAsset({ typeId: e.target.value })}
              >
                {typeItems.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              <select
                className={INPUT}
                aria-label="Status"
                value={data.status}
                onChange={(e) =>
                  void saveAsset({ status: AssetStatusSchema.parse(e.target.value) })
                }
              >
                {AssetStatusSchema.options.map((s) => (
                  <option key={s} value={s}>
                    {label(s)}
                  </option>
                ))}
              </select>
            </div>
            <CommitInput
              label="Description"
              multiline
              value={data.description}
              maxLength={5000}
              onCommit={(description) => saveAsset({ description })}
            />
          </div>

          <section className="space-y-2" aria-label="Projects">
            <h2 className="text-lg font-semibold">Projects</h2>
            {assigned.length === 0 && assignments.data !== null && (
              <p className={MUTED}>Not assigned to any project</p>
            )}
            <ul className="space-y-2">
              {assigned.map((a) => (
                <li key={a.projectId} className={`space-y-1 border-b pb-2 ${BORDER}`}>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      className={BUTTON}
                      disabled={importing}
                      onClick={() => onNavigate({ name: 'project', id: a.projectId })}
                    >
                      {a.project.name}
                    </button>
                    <button
                      type="button"
                      className={BUTTON}
                      aria-label={`Remove ${data.name} from ${a.project.name}`}
                      title="Removes the assignment only; the asset and its files are kept"
                      onClick={() =>
                        void run(async () => {
                          await call('assignments:remove', { projectId: a.projectId, assetId: id });
                          assignments.reload();
                        })
                      }
                    >
                      Remove
                    </button>
                  </div>
                  <AssignmentFields assignment={a} onChanged={() => assignments.reload()} />
                </li>
              ))}
            </ul>
            <div className="flex items-center gap-2">
              <select
                className={INPUT}
                aria-label="Project to add"
                value={effectiveProject}
                onChange={(e) => setProjectToAdd(e.target.value)}
              >
                {unassigned.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className={BUTTON}
                disabled={effectiveProject === ''}
                onClick={() =>
                  void run(async () => {
                    await call('assignments:assign', { projectId: effectiveProject, assetId: id });
                    assignments.reload();
                  })
                }
              >
                Add to project
              </button>
            </div>
          </section>

          <section className="space-y-2" aria-label="Files">
            <h2 className="text-lg font-semibold">Files</h2>
            {files.data !== null && files.data.total === 0 && <p className={MUTED}>No files</p>}
            {groups.map((g) => (
              <div key={g.role}>
                <h3 className={`font-medium ${MUTED}`}>{label(g.role)}</h3>
                <table className="w-full text-left text-sm">
                  <tbody>{g.items.map(fileRow)}</tbody>
                </table>
              </div>
            ))}
            {files.data !== null && files.data.total > PAGE_SIZE && (
              <Pager
                offset={offset}
                limit={PAGE_SIZE}
                total={files.data.total}
                onChange={setOffset}
              />
            )}
            <div className="flex items-center gap-2">
              <select
                className={INPUT}
                aria-label="Role for imported files"
                value={importRole}
                onChange={(e) => setImportRole(FileRoleSchema.parse(e.target.value))}
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {label(r)}
                  </option>
                ))}
              </select>
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
            {results !== null && (
              <div className="space-y-1">
                <p>
                  {imported} imported, {failed.length} failed
                </p>
                {failed.length > 0 && (
                  <ul className="list-disc pl-5 text-sm text-red-800 dark:text-red-300">
                    {failed.map((r) => (
                      <li key={r.file?.id ?? r.sourcePath}>
                        {r.sourcePath}: {r.error}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </section>

          <section className="space-y-2" aria-label="Relations">
            <h2 className="text-lg font-semibold">Relations</h2>
            {relations.data !== null && relations.data.length === 0 && (
              <p className={MUTED}>No relations</p>
            )}
            <ul className="space-y-1">
              {(relations.data ?? []).map((r) => (
                <li
                  key={`${r.fromAssetId}:${r.toAssetId}:${r.kind}`}
                  className="flex items-center gap-2"
                >
                  <span className={MUTED}>{relationLabel(r.kind, r.direction)}</span>
                  <button
                    type="button"
                    className={BUTTON}
                    disabled={importing}
                    onClick={() => onNavigate({ name: 'asset', id: r.other.id })}
                  >
                    {r.other.name}
                  </button>
                  <button
                    type="button"
                    className={BUTTON}
                    aria-label={`Remove relation ${relationLabel(r.kind, r.direction)} ${r.other.name}`}
                    title="Removes the relation only; both assets and their files are kept"
                    onClick={() =>
                      void run(async () => {
                        await call('relations:remove', {
                          fromAssetId: r.fromAssetId,
                          toAssetId: r.toAssetId,
                          kind: r.kind,
                        });
                        relations.reload();
                      })
                    }
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
            <div className="space-y-2">
              <select
                className={INPUT}
                aria-label="Relation kind"
                value={relationKind}
                onChange={(e) => setRelationKind(RelationKindSchema.parse(e.target.value))}
              >
                {RelationKindSchema.options.map((k) => (
                  <option key={k} value={k}>
                    {relationLabel(k, 'outgoing')}
                  </option>
                ))}
              </select>
              <AssetPicker
                excludeIds={[id]}
                onPick={async (other) => {
                  await run(async () => {
                    await call('relations:add', {
                      fromAssetId: id,
                      toAssetId: other.id,
                      kind: relationKind,
                    });
                    relations.reload();
                  });
                }}
              />
            </div>
          </section>
        </>
      )}
    </section>
  );
}
