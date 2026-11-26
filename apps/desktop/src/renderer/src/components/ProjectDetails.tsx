import { useEffect, useState, type ReactNode } from 'react';
import type { AssetList, AssetSummary, ProjectSummary } from '@assetforge/contracts';
import { call, describeError } from '../api';
import { useLoad } from '../hooks/useLoad';
import { label } from '../labels';
import { useTags } from '../tags-context';
import { ALERT, BORDER, BUTTON, LABEL, MUTED, SECTION_TITLE } from '../ui';
import { matchedNames } from './AssetGrid';
import { CoverImage } from './CoverImage';
import { Link } from './Link';
import { TagList } from './TagList';

export const MATCHING_LIMIT = 20;

interface Props {
  project: ProjectSummary | null;
  tagNames: readonly string[];
  onOpenAsset(id: string): void;
  onShowAll(): void;
}

type Matching = { key: string; list: AssetList } | { key: string; error: string };

/** The Project details column of the projects screen, with the member assets that match the tag filter. */
export function ProjectDetails({ project, tagNames, onOpenAsset, onShowAll }: Props) {
  const types = useLoad(() => call('assetTypes:list', {}), []);
  const typeName = (id: string) => (types.data ?? []).find((t) => t.id === id)?.name ?? '–';
  const [matching, setMatching] = useState<Matching | null>(null);
  const { renameToken } = useTags();

  const projectId = project?.id ?? null;
  const tagKey = JSON.stringify(tagNames);
  const requestKey = projectId === null || tagNames.length === 0 ? null : `${projectId}|${tagKey}`;

  useEffect(() => {
    if (requestKey === null || projectId === null) return;
    let active = true;
    const names = JSON.parse(tagKey) as string[];
    call('assets:list', { projectId, tagNames: names, limit: MATCHING_LIMIT, offset: 0 }).then(
      (list) => {
        if (active) setMatching({ key: requestKey, list });
      },
      (e: unknown) => {
        if (active) setMatching({ key: requestKey, error: describeError(e) });
      },
    );
    return () => {
      active = false;
    };
    // A rename asks again under the same key, so the shown answer stays until the new one arrives.
  }, [requestKey, projectId, tagKey, renameToken]);

  // An answer for an earlier selection or other tags is never shown.
  const current = matching !== null && matching.key === requestKey ? matching : null;

  return (
    <div className="flex flex-col gap-4">
      <h2 className={SECTION_TITLE}>Project details</h2>
      {project !== null && (
        <>
          <p className="text-[17px] font-semibold break-words">{project.name}</p>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
            <Field name="Status">{label(project.status)}</Field>
            <Field name="Assets">{project.assetCount}</Field>
            <Field name="Images">{project.imageCount}</Field>
          </dl>
          <section className="flex flex-col gap-1">
            <h3 className={LABEL}>Description</h3>
            <p className="text-sm break-words whitespace-pre-wrap">{project.description === '' ? '–' : project.description}</p>
          </section>
          {requestKey !== null && (
            <section aria-label="Matching content" className="flex flex-col gap-3">
              <h3 className={LABEL}>Matching content</h3>
              {current !== null && 'error' in current && (
                <p role="alert" className={`text-sm ${ALERT}`}>
                  {current.error}
                </p>
              )}
              {current === null && <p className={`text-sm ${MUTED}`}>Loading…</p>}
              {current !== null && 'list' in current && (
                <>
                  {current.list.items.length === 0 && <p className="text-sm">–</p>}
                  <ul className="flex flex-col gap-3">
                    {current.list.items.map((asset) => (
                      <MatchingEntry
                        key={asset.id}
                        asset={asset}
                        typeName={typeName(asset.typeId)}
                        onOpen={() => onOpenAsset(asset.id)}
                      />
                    ))}
                  </ul>
                  {current.list.total > MATCHING_LIMIT && (
                    <div>
                      <button
                        type="button"
                        className={BUTTON}
                        title={`${current.list.total} matching assets`}
                        onClick={onShowAll}
                      >
                        Show all
                      </button>
                    </div>
                  )}
                </>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}

function MatchingEntry({ asset, typeName, onOpen }: { asset: AssetSummary; typeName: string; onOpen(): void }) {
  const fileMatched = matchedNames(asset, 'files');
  const coverNames = new Set(asset.coverTags.map((t) => t.name));
  // The cover tags plus the filter tags found on other files of the asset.
  const imageTags = [
    ...asset.coverTags,
    ...(asset.matchedTags ?? []).filter((t) => t.onFiles && !coverNames.has(t.name)),
  ];
  return (
    <li className={`flex gap-3 border-b pb-3 ${BORDER}`}>
      <CoverImage fileId={asset.coverFileId} size="thumb" fallback="" className="h-14 w-14 shrink-0" />
      <div className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
        <Link onFollow={onOpen} className="truncate font-medium">
          {asset.name}
        </Link>
        <p className={`flex gap-3 ${MUTED}`}>
          <span className="truncate">
            Type <span className="text-text">{typeName}</span>
          </span>
          <span className="truncate">
            Status <span className="text-text">{label(asset.status)}</span>
          </span>
        </p>
        <TagList tags={asset.tags} kind="asset" max={3} matched={matchedNames(asset, 'asset')} />
        <TagList tags={imageTags} kind="file" max={3} matched={fileMatched} />
      </div>
    </li>
  );
}

function Field({ name, children }: { name: string; children: ReactNode }) {
  return (
    <>
      <dt className={LABEL}>{name}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}
