import { Fragment, type ReactNode } from 'react';
import type { FileRecord, TagAssignment } from '@assetforge/contracts';
import { formatBytes, formatDateTime, formatDuration } from '../format';
import { DELETED_LABEL, DURATION_LABEL, label, ORIGIN_LABEL } from '../labels';
import { formatLabel } from '../media-url';
import { ALERT, BORDER, LABEL, PANEL_TITLE } from '../ui';
import { FileOrigins } from './FileOrigins';
import { fileOrigin } from './FileTile';
import { GenerationDetails } from './GenerationDetails';
import { Link } from './Link';
import { Menu, type MenuItem } from './Menu';
import { TagList } from './TagList';
import { TagRow } from './TagRow';

// The details column of the file detail dialog: facts, role or assign control, tags, addresses, generations, the
// asset and the More menu.

/** The asset a file belongs to, as the dialog shows it. */
export interface DialogAsset {
  /** The asset's id. */
  id: string;
  /** The asset's name. */
  name: string;
  /** The asset's own tags. */
  tags: readonly TagAssignment[];
}

/** The props of the details column. */
interface FileDetailsPanelProps {
  /** The shown record. */
  file: FileRecord;
  /** The file's asset; null in the inbox. */
  asset: DialogAsset | null;
  /** The role select or the assign control; null shows no section. */
  roleControl: ReactNode;
  /** The error of the last action on this file; null without one. */
  error: string | null;
  /** The More menu's entries. */
  items: MenuItem[];
  /** Adds or removes a file tag. */
  onChangeTag(channel: 'files:addTag' | 'files:removeTag', name: string): Promise<void>;
  /** Opens the asset; absent shows its name as plain text. */
  onOpenAsset?(assetId: string): void;
}

/**
 * The details column.
 *
 * @param props the file, its asset, the role control, the error, the menu and the callbacks
 * @returns the column
 */
export function FileDetailsPanel({
  file,
  asset,
  roleControl,
  error,
  items,
  onChangeTag,
  onOpenAsset,
}: FileDetailsPanelProps) {
  const complete = file.status === 'complete';
  // A file in the trash: read-only, without a role or assign control.
  const trashed = file.deletedAt !== null;
  const image = file.kind === 'image';
  const tagsLabel = image ? 'Image tags' : 'File tags';
  return (
    <div className={`flex w-88 shrink-0 flex-col gap-6 overflow-y-auto border-r p-5 ${BORDER}`}>
      <FileFacts file={file} />
      {/* The inbox's assign control shows only for complete files. */}
      {!trashed && roleControl !== null && (asset !== null || complete) && (
        <section className="space-y-2">
          <h3 className={PANEL_TITLE}>{asset !== null ? 'Role' : 'Assign'}</h3>
          {/* Keyed by file: stepping on starts the controls afresh. */}
          <Fragment key={`role-${file.id}`}>{roleControl}</Fragment>
        </section>
      )}
      {/* In the trash the tags are kept but cannot be changed. */}
      {trashed && file.tags.length > 0 && (
        <section aria-label={tagsLabel} className="space-y-2">
          <h3 className={PANEL_TITLE}>{tagsLabel}</h3>
          <TagList tags={file.tags} kind="file" max={Number.MAX_SAFE_INTEGER} wrap />
        </section>
      )}
      {!trashed && complete && (
        <TagRow
          key={`tags-${file.id}`}
          label={tagsLabel}
          kind="file"
          layout="stacked"
          tags={file.tags}
          onAdd={(name) => onChangeTag('files:addTag', name)}
          onRemove={(name) => onChangeTag('files:removeTag', name)}
        />
      )}
      {/* Keyed by file: stepping on loads the next file's addresses afresh. */}
      <FileOrigins key={`origins-${file.id}`} fileId={file.id} />
      {complete && <GenerationDetails key={`generation-${file.id}`} fileId={file.id} />}
      {asset !== null && (
        <>
          <hr className={`border-t ${BORDER}`} />
          <section className="space-y-2">
            <h3 className={PANEL_TITLE}>Asset</h3>
            <div className="break-words">
              {onOpenAsset ? (
                <Link onFollow={() => onOpenAsset(asset.id)}>{asset.name}</Link>
              ) : (
                <span>{asset.name}</span>
              )}
            </div>
          </section>
          {asset.tags.length > 0 && (
            <section className="space-y-2">
              <h3 className={PANEL_TITLE}>Asset tags</h3>
              <TagList tags={asset.tags} kind="asset" max={Number.MAX_SAFE_INTEGER} wrap />
            </section>
          )}
        </>
      )}
      {error !== null && (
        <p role="alert" className={ALERT}>
          {error}
        </p>
      )}
      <div>
        <Menu label="More" items={items} align="start" side="top" trigger="labelled" />
      </div>
    </div>
  );
}

/**
 * The facts of a file: name, format, dimensions, duration, size, dates, origin, status and import error.
 *
 * @param props the file
 * @returns the Details section
 */
function FileFacts({ file }: { file: FileRecord }) {
  const complete = file.status === 'complete';
  return (
    <section aria-label="Details" className="space-y-2">
      <h3 className={PANEL_TITLE}>{file.kind === 'image' ? 'Image details' : 'File details'}</h3>
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-1.5 text-sm">
        <dt className={LABEL}>Filename</dt>
        <dd className="break-all">{file.originalName}</dd>
        <dt className={LABEL}>Format</dt>
        <dd title={file.mimeType}>{formatLabel(file.originalName)}</dd>
        <dt className={LABEL}>Dimensions</dt>
        <dd>{file.width !== null && file.height !== null ? `${file.width} × ${file.height} px` : '–'}</dd>
        {file.durationMs !== null && (
          <>
            <dt className={LABEL}>{DURATION_LABEL}</dt>
            <dd className="tabular-nums">{formatDuration(file.durationMs)}</dd>
          </>
        )}
        <dt className={LABEL}>Size</dt>
        <dd>{formatBytes(file.sizeBytes)}</dd>
        <dt className={LABEL}>Imported</dt>
        <dd>{formatDateTime(file.importedAt)}</dd>
        {file.deletedAt !== null && (
          <>
            <dt className={LABEL}>{DELETED_LABEL}</dt>
            <dd>{formatDateTime(file.deletedAt)}</dd>
            <dt className={LABEL}>{ORIGIN_LABEL}</dt>
            <dd className="break-words">{fileOrigin(file)}</dd>
          </>
        )}
        {!complete && (
          <>
            <dt className={LABEL}>Status</dt>
            <dd>{label(file.status)}</dd>
          </>
        )}
      </dl>
      {file.error !== null && (
        <p role="alert" className={ALERT}>
          {file.error}
        </p>
      )}
    </section>
  );
}
