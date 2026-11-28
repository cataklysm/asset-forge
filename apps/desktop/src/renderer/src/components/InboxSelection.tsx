import { useId, useRef, useState, type RefObject } from 'react';
import { FileRoleSchema, type Asset, type FileRecord, type FileRole } from '@assetforge/contracts';
import { call, describeError } from '../api';
import { label } from '../labels';
import { eligibleFiles, NONE_ELIGIBLE, sharedTags, type FileSelection } from '../selection';
import { ALERT, BUTTON, LABEL, MUTED, SECTION_TITLE, SELECT } from '../ui';
import { AssetPicker } from './AssetPicker';
import { assignFailures, ResultStrip, type ResultFailure } from './ResultStrip';
import { TagRow } from './TagRow';

// The Selection column of the inbox.

/** Every file role, in the order of the schema. */
const ROLES = FileRoleSchema.options;

interface Props {
  /** The selected files. */
  selection: FileSelection;
  /** The shared tag input; the selection bar's "Add tags" focuses it. */
  tagInputRef: RefObject<HTMLInputElement | null>;
  /** After an assign: the files that moved to the asset. The host drops them and reloads. */
  onAssigned(movedIds: string[]): void;
  /**
   * After the shared tags changed: the changed records. The host refreshes its current selection
   * with them (the answer may arrive after the selection changed) and reloads.
   */
  onFilesChanged(items: FileRecord[]): void;
}

/**
 * A count with its noun.
 *
 * @param count the count
 * @param one the noun for one
 * @param many the noun for any other count
 * @returns for example `3 files`
 */
function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The marker after a selected file's name. */
interface Marker {
  /** The text. */
  text: string;
  /** The tooltip. */
  title: string | undefined;
  /** Shown in the danger colour. */
  failed: boolean;
}

/**
 * The marker of a selected file: its assign error, else its import status when it is not complete.
 *
 * @param file the file
 * @param assignError the error of the last assign; undefined when it did not fail
 * @returns the marker; null for none
 */
function markerOf(file: FileRecord, assignError: string | undefined): Marker | null {
  return assignError !== undefined
    ? { text: label('failed'), title: assignError, failed: true }
    : file.status !== 'complete'
      ? { text: label(file.status), title: file.error ?? undefined, failed: file.status === 'failed' }
      : null;
}

/**
 * The Selection column of the inbox: the size of the selection, its shared image tags, the batch
 * assign to an asset and the selected names. Files that are not completely imported are marked
 * and left out of tagging and assigning.
 *
 * @param props the selection, the tag input and the callbacks
 * @returns the column
 */
export function InboxSelection({ selection, tagInputRef, onAssigned, onFilesChanged }: Props) {
  const [asset, setAsset] = useState<Asset | null>(null);
  const [role, setRole] = useState<FileRole>('reference');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ title: string; failures: ResultFailure[] } | null>(null);
  // Synchronous guard: a second activation before the re-render must not send a second request.
  const assigning = useRef(false);
  const assignId = useId();
  // Assign answers arrive later; names come from the selection as it is then.
  const latest = useRef(selection);
  latest.current = selection;

  const files = [...selection.selected.values()];
  const eligible = eligibleFiles(selection);
  const eligibleIds = eligible.map((file) => file.id);
  const allImages = files.length > 0 && files.every((file) => file.kind === 'image');
  const failedMessage = new Map(result?.failures.map((failure) => [failure.key, failure.message]) ?? []);

  /** Adds or removes a tag on every eligible file. */
  async function changeTags(channel: 'files:addTagMany' | 'files:removeTagMany', name: string) {
    const { items } = await call(channel, { fileIds: eligibleIds, name });
    onFilesChanged(items);
  }

  /** Assigns every eligible file to the picked asset, once at a time, and reports per-file failures. */
  async function assign() {
    if (assigning.current || asset === null || eligibleIds.length === 0) return;
    assigning.current = true;
    setBusy(true);
    setError(null);
    const nameOf = (fileId: string) => latest.current.selected.get(fileId)?.originalName ?? fileId;
    try {
      const { items } = await call('files:assignMany', { fileIds: eligibleIds, assetId: asset.id, role });
      const failures = assignFailures(items, nameOf);
      const moved = items.flatMap((item) => (item.error === null ? [item.fileId] : []));
      setResult(
        failures.length === 0 ? null : { title: `${moved.length} assigned, ${failures.length} failed`, failures },
      );
      onAssigned(moved);
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      assigning.current = false;
      setBusy(false);
    }
  }

  const noneEligible = eligible.length === 0;

  return (
    <div className="flex flex-col gap-4">
      <h2 className={SECTION_TITLE}>Selection</h2>
      <p className="text-sm tabular-nums">
        {allImages ? plural(files.length, 'image', 'images') : plural(files.length, 'file', 'files')}
      </p>

      <TagRow
        label="Shared image tags"
        kind="file"
        tags={sharedTags(eligible)}
        onAdd={(name) => changeTags('files:addTagMany', name)}
        onRemove={(name) => changeTags('files:removeTagMany', name)}
        disabled={noneEligible}
        inputRef={tagInputRef}
      />

      <section aria-labelledby={assignId} className="flex flex-col gap-2">
        <h3 id={assignId} className={LABEL}>
          Assign to asset
        </h3>
        <AssetPicker onPick={setAsset} />
        {asset !== null && (
          <p className="break-words text-sm" title="Target asset">
            {asset.name}
          </p>
        )}
        <select
          className={SELECT}
          aria-label="Role"
          value={role}
          onChange={(event) => setRole(FileRoleSchema.parse(event.target.value))}
        >
          {ROLES.map((option) => (
            <option key={option} value={option}>
              {label(option)}
            </option>
          ))}
        </select>
        <div>
          <button
            type="button"
            className={BUTTON}
            disabled={noneEligible || asset === null || busy}
            title={noneEligible ? NONE_ELIGIBLE : asset === null ? 'Pick an asset first' : undefined}
            onClick={() => void assign()}
          >
            Assign {plural(eligible.length, 'file', 'files')}
          </button>
        </div>
        {error !== null && (
          <p role="alert" className={ALERT}>
            {error}
          </p>
        )}
        {result !== null && (
          <ResultStrip title={result.title} failures={result.failures} onDismiss={() => setResult(null)} />
        )}
      </section>

      <ul aria-label="Selected files" className="flex flex-col gap-1 text-sm">
        {files.map((file) => {
          const marker = markerOf(file, failedMessage.get(file.id));
          return (
            <li key={file.id} className="flex min-w-0 items-baseline gap-2">
              <span className="min-w-0 truncate" title={file.originalName}>
                {file.originalName}
              </span>
              {marker !== null && (
                <span className={`shrink-0 text-[13px] ${marker.failed ? 'text-danger' : MUTED}`} title={marker.title}>
                  {marker.text}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
