import { useState } from 'react';
import { ProjectStatusSchema } from '@assetforge/contracts';
import { call, describeError } from '../api';
import { AssetPicker } from '../components/AssetPicker';
import { AssignmentFields } from '../components/AssignmentFields';
import { CommitInput } from '../components/CommitInput';
import { Pager } from '../components/Pager';
import { useLoad } from '../hooks/useLoad';
import { label } from '../labels';
import type { View } from '../nav';
import { ALERT, BORDER, BUTTON, INPUT, MUTED } from '../ui';

const PAGE_SIZE = 50;

export function ProjectScreen({ id, onNavigate }: { id: string; onNavigate(view: View): void }) {
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const project = useLoad(() => call('projects:get', { id }), [id]);
  const types = useLoad(() => call('assetTypes:list', {}), []);
  const members = useLoad(
    () => call('assignments:listByProject', { projectId: id, limit: PAGE_SIZE, offset }),
    [id, offset],
  );
  // The picker must exclude every member, not only those on the visible page.
  const allMembers = useLoad(
    () => call('assignments:listByProject', { projectId: id, limit: 200, offset: 0 }),
    [id],
  );

  function reloadMembers() {
    members.reload();
    allMembers.reload();
  }

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

  const saveProject = (patch: Parameters<typeof call<'projects:update'>>[1]['patch']) =>
    run(async () => {
      await call('projects:update', { id, patch });
      project.reload();
    });

  const data = project.data;
  const typeName = (typeId: string) => (types.data ?? []).find((t) => t.id === typeId)?.name ?? '–';
  const loadErrors = [project, types, members, allMembers]
    .map((l) => l.error)
    .filter((e): e is string => e !== null);

  return (
    <section className="space-y-6" aria-label="Project">
      <div>
        <button type="button" className={BUTTON} onClick={() => onNavigate({ name: 'projects' })}>
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
        project.error === null && <p className={MUTED}>Loading…</p>
      ) : (
        <>
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <CommitInput
                label="Name"
                value={data.name}
                maxLength={200}
                onCommit={(name) => saveProject({ name })}
              />
              <select
                className={INPUT}
                aria-label="Status"
                value={data.status}
                onChange={(e) =>
                  void saveProject({ status: ProjectStatusSchema.parse(e.target.value) })
                }
              >
                {ProjectStatusSchema.options.map((s) => (
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
              onCommit={(description) => saveProject({ description })}
            />
          </div>

          <section className="space-y-2" aria-label="Assets">
            <h2 className="text-lg font-semibold">Assets</h2>
            {members.data !== null && members.data.total === 0 && (
              <p className={MUTED}>No assets assigned</p>
            )}
            <ul className="space-y-2">
              {(members.data?.items ?? []).map((m) => (
                <li key={m.assetId} className={`space-y-1 border-b pb-2 ${BORDER}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      className={BUTTON}
                      onClick={() => onNavigate({ name: 'asset', id: m.assetId })}
                    >
                      {m.asset.name}
                    </button>
                    <span className={MUTED}>{typeName(m.asset.typeId)}</span>
                    <span className={MUTED}>{label(m.asset.status)}</span>
                    <button
                      type="button"
                      className={BUTTON}
                      aria-label={`Remove ${m.asset.name} from ${data.name}`}
                      title="Removes the assignment only; the asset and its files are kept"
                      onClick={() =>
                        void run(async () => {
                          await call('assignments:remove', { projectId: id, assetId: m.assetId });
                          reloadMembers();
                        })
                      }
                    >
                      Remove
                    </button>
                  </div>
                  <AssignmentFields assignment={m} onChanged={() => reloadMembers()} />
                </li>
              ))}
            </ul>
            {members.data !== null && members.data.total > PAGE_SIZE && (
              <Pager
                offset={offset}
                limit={PAGE_SIZE}
                total={members.data.total}
                onChange={setOffset}
              />
            )}
            <AssetPicker
              excludeIds={(allMembers.data?.items ?? []).map((m) => m.assetId)}
              onPick={async (asset) => {
                await run(async () => {
                  await call('assignments:assign', { projectId: id, assetId: asset.id });
                  reloadMembers();
                });
              }}
            />
          </section>
        </>
      )}
    </section>
  );
}
