import { assetCount, fileCount, promptCount } from './counts';

/** The rename tag dialog (RenameTagDialog) and the pencil on an editable tag chip. */
export const RENAME_TAG_TITLE = 'Rename tag';
export const TAG_NAME_LABEL = 'Name';
export const RENAME_LABEL = 'Rename';
export const MERGE_LABEL = 'Merge';

/**
 * The accessible name of the pencil on a chip: 'Rename front view'.
 *
 * @param displayName the tag's display name
 * @returns the accessible name
 */
export function renameTagLabel(displayName: string): string {
  return `${RENAME_LABEL} ${displayName}`;
}

/** The counts of one tag, as `tags:usage` answers them. */
interface TagUsageCounts {
  displayName: string;
  files: number;
  assets: number;
  prompts: number;
}

/**
 * 'front view · 42 files · 3 assets · 1 prompt'.
 *
 * @param usage the tag's display name and counts
 * @returns the usage line of the rename dialog
 */
export function tagUsageLine(usage: TagUsageCounts): string {
  return `${usage.displayName} · ${fileCount(usage.files)} · ${assetCount(usage.assets)} · ${promptCount(usage.prompts)}`;
}

/**
 * 'Merges with front · 118 files · 5 assets · 0 prompts'.
 *
 * @param usage the display name and counts of the existing target tag
 * @returns the merge line of the rename dialog
 */
export function tagMergeLine(usage: TagUsageCounts): string {
  return `Merges with ${tagUsageLine(usage)}`;
}
