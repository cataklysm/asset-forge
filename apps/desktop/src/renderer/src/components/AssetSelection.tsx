import { useEffect, useState, type ReactNode } from 'react';
import type { AssetSummary } from '@assetforge/contracts';
import { call, describeError } from '../api';
import { ANALYSE_ASSET_TITLE, ANALYSE_LABEL, label } from '../labels';
import { ALERT, BUTTON, LABEL, SECTION_TITLE } from '../ui';
import { matchedNames } from './AssetGrid';
import { CoverImage } from './CoverImage';
import { TagList } from './TagList';

interface Props {
  asset: AssetSummary | null;
  typeName(id: string): string;
  onOpen(): void;
  /** Opens the start dialog for the images of the asset; without it there is no Analyse button. */
  onAnalyse?(assetId: string): void;
  /** Why no analysis can start, as tooltip of the disabled Analyse button. */
  analyseBlocked?: string | null;
}

type Projects = { assetId: string; names: string[] } | { assetId: string; error: string };

/** The Selection column of the assets screen: a summary of the selected asset. */
export function AssetSelection({ asset, typeName, onOpen, onAnalyse, analyseBlocked = null }: Props) {
  const [projects, setProjects] = useState<Projects | null>(null);
  const assetId = asset?.id ?? null;

  useEffect(() => {
    if (assetId === null) return;
    let active = true;
    call('assignments:listByAsset', { assetId }).then(
      (list) => {
        if (active) setProjects({ assetId, names: list.map((a) => a.project.name) });
      },
      (e: unknown) => {
        if (active) setProjects({ assetId, error: describeError(e) });
      },
    );
    return () => {
      active = false;
    };
  }, [assetId]);

  // An answer for an earlier selection is never shown; until the current one arrives, a dash.
  const current = projects !== null && projects.assetId === assetId ? projects : null;

  return (
    <div className="flex flex-col gap-4">
      <h2 className={SECTION_TITLE}>Selection</h2>
      {asset !== null && (
        <>
          <p className="text-[17px] font-semibold break-words">{asset.name}</p>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
            <Field name="Type">{typeName(asset.typeId)}</Field>
            <Field name="Status">{label(asset.status)}</Field>
            <Field name="Files">{asset.fileCount}</Field>
            <Field name="Projects">
              {current !== null && 'error' in current ? null : (
                <span data-projects="">
                  {current === null || current.names.length === 0 ? '–' : current.names.join(', ')}
                </span>
              )}
            </Field>
          </dl>
          {current !== null && 'error' in current && (
            <p role="alert" className={`text-sm ${ALERT}`}>
              {current.error}
            </p>
          )}
          <section className="flex flex-col gap-2">
            <h3 className={LABEL}>Asset tags</h3>
            {asset.tags.length === 0 ? (
              <span className="text-sm">–</span>
            ) : (
              <TagList tags={asset.tags} kind="asset" max={3} matched={matchedNames(asset, 'asset')} />
            )}
          </section>
          {asset.coverFileId !== null && (
            <section className="flex flex-col gap-2">
              <h3 className={LABEL}>Cover image</h3>
              <CoverImage
                fileId={asset.coverFileId}
                size="thumb"
                fallback={typeName(asset.typeId)}
                className="aspect-[4/3] w-full"
              />
              {asset.coverTags.length > 0 && (
                <TagList tags={asset.coverTags} kind="file" max={3} matched={matchedNames(asset, 'files')} />
              )}
            </section>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" className={BUTTON} onClick={onOpen}>
              Open asset
            </button>
            {onAnalyse !== undefined && (
              <button
                type="button"
                className={BUTTON}
                disabled={analyseBlocked !== null}
                title={analyseBlocked ?? ANALYSE_ASSET_TITLE}
                onClick={() => onAnalyse(asset.id)}
              >
                {ANALYSE_LABEL}
              </button>
            )}
          </div>
        </>
      )}
    </div>
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
