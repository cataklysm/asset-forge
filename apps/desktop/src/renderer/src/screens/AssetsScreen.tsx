import { useState, type FormEvent } from 'react';
import { AssetStatusSchema } from '@assetforge/contracts';
import { call, describeError } from '../api';
import { Pager } from '../components/Pager';
import { useLoad } from '../hooks/useLoad';
import { label } from '../labels';
import { ALERT, BORDER, BUTTON, INPUT, MUTED } from '../ui';

const PAGE_SIZE = 50;
const STATUSES = AssetStatusSchema.options;

export function AssetsScreen({ onOpen }: { onOpen(id: string): void }) {
  const [offset, setOffset] = useState(0);
  const [typeId, setTypeId] = useState('');
  const [status, setStatus] = useState('');
  const [projectId, setProjectId] = useState('');
  const [nameFilter, setNameFilter] = useState('');
  const [newName, setNewName] = useState('');
  const [newTypeId, setNewTypeId] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const types = useLoad(() => call('assetTypes:list', {}), []);
  const projects = useLoad(() => call('projects:list', { limit: 200, offset: 0 }), []);
  const list = useLoad(
    () =>
      call('assets:list', {
        limit: PAGE_SIZE,
        offset,
        ...(typeId !== '' && { typeId }),
        ...(status !== '' && { status: AssetStatusSchema.parse(status) }),
        ...(projectId !== '' && { projectId }),
        ...(nameFilter.trim() !== '' && { nameContains: nameFilter.trim() }),
      }),
    [offset, typeId, status, projectId, nameFilter],
  );

  const typeItems = types.data ?? [];
  const typeName = (id: string) => typeItems.find((t) => t.id === id)?.name ?? '–';
  const effectiveNewType = newTypeId !== '' ? newTypeId : (typeItems[0]?.id ?? '');

  function filter(apply: () => void) {
    apply();
    setOffset(0);
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    if (newName.trim() === '' || effectiveNewType === '') return;
    setCreating(true);
    setCreateError(null);
    try {
      const asset = await call('assets:create', { name: newName.trim(), typeId: effectiveNewType });
      onOpen(asset.id);
    } catch (e) {
      setCreateError(describeError(e));
    } finally {
      setCreating(false);
    }
  }

  const errors = [types.error, projects.error, list.error].filter((e): e is string => e !== null);

  return (
    <section className="space-y-4" aria-label="Assets">
      <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => void create(e)}>
        <input
          className={INPUT}
          aria-label="Asset name"
          placeholder="Asset name"
          value={newName}
          maxLength={200}
          onChange={(e) => setNewName(e.target.value)}
        />
        <select
          className={INPUT}
          aria-label="Asset type"
          value={effectiveNewType}
          onChange={(e) => setNewTypeId(e.target.value)}
        >
          {typeItems.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className={BUTTON}
          disabled={creating || newName.trim() === '' || effectiveNewType === ''}
        >
          Create
        </button>
      </form>
      {createError !== null && (
        <p role="alert" className={ALERT}>
          {createError}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <select
          className={INPUT}
          aria-label="Filter by type"
          value={typeId}
          onChange={(e) => filter(() => setTypeId(e.target.value))}
        >
          <option value="">All types</option>
          {typeItems.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <select
          className={INPUT}
          aria-label="Filter by status"
          value={status}
          onChange={(e) => filter(() => setStatus(e.target.value))}
        >
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {label(s)}
            </option>
          ))}
        </select>
        <select
          className={INPUT}
          aria-label="Filter by project"
          value={projectId}
          onChange={(e) => filter(() => setProjectId(e.target.value))}
        >
          <option value="">All projects</option>
          {(projects.data?.items ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <input
          className={INPUT}
          aria-label="Filter by name"
          placeholder="Name"
          value={nameFilter}
          onChange={(e) => filter(() => setNameFilter(e.target.value))}
        />
      </div>

      {errors.map((message) => (
        <p key={message} role="alert" className={ALERT}>
          {message}
        </p>
      ))}

      {list.data === null ? (
        list.error === null && <p className={MUTED}>Loading…</p>
      ) : (
        <>
          <table className="w-full text-left text-sm">
            <thead className={`border-b ${BORDER} ${MUTED}`}>
              <tr>
                <th className="py-1 pr-3">Name</th>
                <th className="py-1 pr-3">Type</th>
                <th className="py-1 pr-3">Status</th>
                <th className="py-1 pr-3">Projects</th>
                <th className="py-1">Files</th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((asset) => (
                <tr key={asset.id} className={`border-b ${BORDER}`}>
                  <td className="py-1 pr-3">
                    <button type="button" className={BUTTON} onClick={() => onOpen(asset.id)}>
                      {asset.name}
                    </button>
                  </td>
                  <td className="py-1 pr-3">{typeName(asset.typeId)}</td>
                  <td className="py-1 pr-3">{label(asset.status)}</td>
                  <td className="py-1 pr-3">{asset.projectCount}</td>
                  <td className="py-1">{asset.fileCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.data.total === 0 && <p className={MUTED}>No assets found.</p>}
          <Pager offset={offset} limit={PAGE_SIZE} total={list.data.total} onChange={setOffset} />
        </>
      )}
    </section>
  );
}
