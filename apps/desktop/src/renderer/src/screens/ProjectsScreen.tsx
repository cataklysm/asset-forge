import { useState, type FormEvent } from 'react';
import { call, describeError } from '../api';
import { Pager } from '../components/Pager';
import { useLoad } from '../hooks/useLoad';
import { label } from '../labels';
import { ALERT, BORDER, BUTTON, INPUT, MUTED } from '../ui';

const PAGE_SIZE = 50;

export function ProjectsScreen({ onOpen }: { onOpen(id: string): void }) {
  const [offset, setOffset] = useState(0);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const { data, error } = useLoad(
    () => call('projects:list', { limit: PAGE_SIZE, offset }),
    [offset],
  );

  async function create(event: FormEvent) {
    event.preventDefault();
    if (name.trim() === '') return;
    setCreating(true);
    setCreateError(null);
    try {
      const project = await call('projects:create', { name: name.trim() });
      onOpen(project.id);
    } catch (e) {
      setCreateError(describeError(e));
    } finally {
      setCreating(false);
    }
  }

  return (
    <section className="space-y-4" aria-label="Projects">
      <form className="flex items-center gap-2" onSubmit={(e) => void create(e)}>
        <input
          className={INPUT}
          aria-label="Project name"
          placeholder="Project name"
          value={name}
          maxLength={200}
          onChange={(e) => setName(e.target.value)}
        />
        <button type="submit" className={BUTTON} disabled={creating || name.trim() === ''}>
          Create
        </button>
      </form>
      {createError !== null && (
        <p role="alert" className={ALERT}>
          {createError}
        </p>
      )}
      {error !== null && (
        <p role="alert" className={ALERT}>
          {error}
        </p>
      )}
      {data === null ? (
        error === null && <p className={MUTED}>Loading…</p>
      ) : (
        <>
          <table className="w-full text-left text-sm">
            <thead className={`border-b ${BORDER} ${MUTED}`}>
              <tr>
                <th className="py-1 pr-3">Name</th>
                <th className="py-1 pr-3">Status</th>
                <th className="py-1">Assets</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((project) => (
                <tr key={project.id} className={`border-b ${BORDER}`}>
                  <td className="py-1 pr-3">
                    <button type="button" className={BUTTON} onClick={() => onOpen(project.id)}>
                      {project.name}
                    </button>
                  </td>
                  <td className="py-1 pr-3">{label(project.status)}</td>
                  <td className="py-1">{project.assetCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.total === 0 && <p className={MUTED}>No projects yet.</p>}
          <Pager offset={offset} limit={PAGE_SIZE} total={data.total} onChange={setOffset} />
        </>
      )}
    </section>
  );
}
