import type { TagAssignment } from '@assetforge/contracts';
import { Image as ImageIcon } from 'lucide-react';
import { useCallback, useId, useRef, type KeyboardEvent, type Ref, type RefObject } from 'react';
import { useTagRowEdit } from '../hooks/useTagRowEdit';
import { chipRemoveButtons, useTagRowFocus } from '../hooks/useTagRowFocus';
import { ADD_ASSET_TAG_LABEL, ADD_IMAGE_TAG_LABEL, ADD_PROMPT_TAG_LABEL, ADD_TAG_PLACEHOLDER } from '../labels';
import type { TagRename } from '../tag-rename';
import { useTags, type TagsState } from '../tags-context';
import { ALERT, LABEL, PANEL_TITLE } from '../ui';
import { TagChip } from './TagChip';
import { TagCombobox } from './TagCombobox';

export { INVALID_TAG } from '../hooks/useTagRowEdit';

/** The props of `TagRow`. */
interface Props {
  /** The visible label and the accessible name of the row. */
  label: 'Asset tags' | 'Image tags' | 'File tags' | 'Shared image tags' | 'Prompt tags';
  /** Whose tags these are; file tags get the image icon. */
  kind: 'asset' | 'file' | 'prompt';
  /**
   * `inline` (the default): label, chips and a boxed input in one wrapping row. `stacked`: the label
   * as a panel heading, the chips below it and the input as an action after them.
   */
  layout?: 'inline' | 'stacked';
  /** The tags, in order. */
  tags: readonly TagAssignment[];
  /** Adds a tag by display name; a rejection shows below the row. */
  onAdd(displayName: string): Promise<void>;
  /** Removes a tag by name; a rejection shows below the row. */
  onRemove(name: string): Promise<void>;
  /** Hides the remove and rename buttons and disables the input. */
  disabled?: boolean;
  /** Receives the input element. */
  inputRef?: Ref<HTMLInputElement>;
}

/**
 * Hands an element to a callback or object ref.
 *
 * @param ref the ref, or undefined
 * @param value the element, or null on unmount
 */
function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === 'function') ref(value);
  else if (ref) ref.current = value;
}

/**
 * The accessible name of the add input.
 *
 * @param kind whose tags the row holds
 * @returns the name
 */
function addLabel(kind: Props['kind']): string {
  if (kind === 'asset') return ADD_ASSET_TAG_LABEL;
  return kind === 'prompt' ? ADD_PROMPT_TAG_LABEL : ADD_IMAGE_TAG_LABEL;
}

/** The props of `TagRowChip`. */
interface TagRowChipProps {
  tag: TagAssignment;
  index: number;
  disabled: boolean;
  openRename: TagsState['openRename'];
  /** Set after a rename from this chip's pencil that changed the name. */
  renamedFocus: RefObject<TagRename | null>;
  remove(name: string, index: number): Promise<void>;
}

/**
 * One chip of the row: Delete or Backspace on it removes it, the pencil opens the rename dialog.
 *
 * @param props the tag, its index, the disabled flag, the rename opener and the remove
 * @returns the chip in its focus wrapper
 */
function TagRowChip({ tag, index, disabled, openRename, renamedFocus, remove }: TagRowChipProps) {
  return (
    <span
      data-chip=""
      className="max-w-full"
      onKeyDown={(event) => {
        if (event.key !== 'Delete' && event.key !== 'Backspace') return;
        // The pencil renames; only the chip and its remove button remove.
        if (event.target instanceof Element && event.target.closest('[data-rename]') !== null) return;
        event.preventDefault();
        void remove(tag.name, index);
      }}
    >
      <TagChip
        tag={tag}
        onRemove={disabled ? undefined : () => void remove(tag.name, index)}
        onRename={
          disabled || openRename === null
            ? undefined
            : () =>
                openRename({ name: tag.name, displayName: tag.displayName }, (change) => {
                  // Another spelling keeps the chip and its key; the dialog gives the pencil its focus back.
                  renamedFocus.current = change.from !== change.name ? change : null;
                })
        }
      />
    </span>
  );
}

/**
 * Editable tags of one owner: chips with remove and an input with suggestions. Backspace in the
 * empty input focuses the last chip; Delete or Backspace on a chip removes it and keeps focus in the row.
 *
 * @param props the label, the owner kind, the layout, the tags, the add and remove callbacks and the input ref
 * @returns the row with its error line
 */
export function TagRow({ label, kind, layout = 'inline', tags, onAdd, onRemove, disabled = false, inputRef }: Props) {
  const labelId = useId();
  const rowRef = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const { pendingFocus, renamedFocus } = useTagRowFocus(tags, rowRef, input);
  const { text, setText, error, setError, add, remove } = useTagRowEdit(onAdd, onRemove, pendingFocus);
  const { openRename } = useTags();

  const setInput = useCallback(
    (element: HTMLInputElement | null) => {
      input.current = element;
      assignRef(inputRef, element);
    },
    [inputRef],
  );

  function onInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Backspace' || event.currentTarget.value !== '') return;
    const last = chipRemoveButtons(rowRef.current).at(-1);
    if (last === undefined) return;
    event.preventDefault();
    last.focus();
  }

  const stacked = layout === 'stacked';
  const icon = kind === 'file' && <ImageIcon size={16} aria-hidden className="shrink-0 text-muted" />;
  return (
    <div className={stacked ? 'space-y-2' : undefined}>
      {stacked && (
        <div className="flex items-center gap-2">
          <h3 id={labelId} className={PANEL_TITLE}>
            {label}
          </h3>
          {icon}
        </div>
      )}
      <div ref={rowRef} role="group" aria-labelledby={labelId} className="flex flex-wrap items-center gap-1.5">
        {!stacked && (
          <>
            <span id={labelId} className={`${LABEL} mr-1`}>
              {label}
            </span>
            {icon}
          </>
        )}
        {tags.map((tag, index) => (
          <TagRowChip
            key={tag.name}
            tag={tag}
            index={index}
            disabled={disabled}
            openRename={openRename}
            renamedFocus={renamedFocus}
            remove={remove}
          />
        ))}
        <TagCombobox
          value={text}
          onValueChange={(value) => {
            setText(value);
            setError(null);
          }}
          onCommit={(value) => void add(value)}
          placeholder={ADD_TAG_PLACEHOLDER}
          label={addLabel(kind)}
          inputRef={setInput}
          onKeyDown={onInputKeyDown}
          disabled={disabled}
          look={stacked ? 'inline' : 'box'}
        />
      </div>
      {error !== null && (
        <p role="alert" className={`mt-2 ${ALERT}`}>
          {error}
        </p>
      )}
    </div>
  );
}
