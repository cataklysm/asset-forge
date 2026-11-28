import type { ReactNode } from 'react';
import type { AssetSummary, ProjectSummary } from '@assetforge/contracts';
import { call } from '../api';
import { useLoad } from '../hooks/useLoad';
import { MATCHING_LIMIT, useMatchingAssets, type Matching } from '../hooks/useMatchingAssets';
import { label } from '../labels';
import { ALERT, BORDER, BUTTON, LABEL, MUTED, SECTION_TITLE } from '../ui';
import { matchedNames } from './AssetGrid';
import { CoverImage } from './CoverImage';
import { Link } from './Link';
import { TagList } from './TagList';

export { MATCHING_LIMIT } from '../hooks/useMatchingAssets';

/** The props of `ProjectDetails`. */
interface Props {
  /** The selected project, or null. */
  project: ProjectSummary | null;
  /** The tag filter of the projects screen. */
  tagNames: readonly string[];
  onOpenAsset(id: string): void;
  /** Shows every matching asset in the gallery. */
  onShowAll(): void;
}

/**
 * The Project details column of the projects screen, with the member assets that match the tag filter.
 *
 * @param props the project, the tag filter and the callbacks
 * @returns the details column
 */
export function ProjectDetails({ project, tagNames, onOpenAsset, onShowAll }: Props) {
  const types = useLoad(() => call('assetTypes:list', {}), []);
  const typeName = (id: string) => (types.data ?? []).find((type) => type.id === id)?.name ?? '–';
  const { requestKey, current } = useMatchingAssets(project?.id ?? null, tagNames);

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
            <p className="text-sm break-words whitespace-pre-wrap">
              {project.description === '' ? '–' : project.description}
            </p>
          </section>
          {requestKey !== null && (
            <MatchingSection current={current} typeName={typeName} onOpenAsset={onOpenAsset} onShowAll={onShowAll} />
          )}
        </>
      )}
    </div>
  );
}

/** The props of `MatchingSection`. */
interface MatchingSectionProps {
  /** The answer for the current request, or null while it is outstanding. */
  current: Matching | null;
  /** The name of an asset type by id. */
  typeName(id: string): string;
  onOpenAsset(id: string): void;
  onShowAll(): void;
}

/**
 * The Matching content section: loading, the error, or the matching assets with Show all.
 *
 * @param props the answer, the type names and the callbacks
 * @returns the section
 */
function MatchingSection({ current, typeName, onOpenAsset, onShowAll }: MatchingSectionProps) {
  return (
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
  );
}

/**
 * One matching asset: cover, name link, type, status and its asset and image tags.
 *
 * @param props the asset, its type name and the open
 * @returns the list entry
 */
function MatchingEntry({ asset, typeName, onOpen }: { asset: AssetSummary; typeName: string; onOpen(): void }) {
  const fileMatched = matchedNames(asset, 'files');
  const coverNames = new Set(asset.coverTags.map((tag) => tag.name));
  // The cover tags plus the filter tags found on other files of the asset.
  const imageTags = [
    ...asset.coverTags,
    ...(asset.matchedTags ?? []).filter((tag) => tag.onFiles && !coverNames.has(tag.name)),
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

/**
 * One term and value of the details list.
 *
 * @param props the term and the value
 * @returns the dt and dd pair
 */
function Field({ name, children }: { name: string; children: ReactNode }) {
  return (
    <>
      <dt className={LABEL}>{name}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}
