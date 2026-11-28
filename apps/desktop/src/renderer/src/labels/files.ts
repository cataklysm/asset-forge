import type { FileKind } from '@assetforge/contracts';

/** The entries of the file type filters, in this order. */
export const FILE_KIND_OPTIONS: readonly { kind: FileKind; title: string }[] = [
  { kind: 'image', title: 'Image' },
  { kind: 'video', title: 'Video' },
  { kind: 'model', title: '3D model' },
  { kind: 'document', title: 'Document' },
  { kind: 'other', title: 'Other' },
];

/** The accessible name of the film icon on video tiles and film strip entries. */
export const VIDEO_LABEL = 'Video';
/** The video stage of the file detail dialog. */
export const VIDEO_UNPLAYABLE_TEXT = 'This video cannot be played here';
export const OPEN_EXTERNALLY_LABEL = 'Open externally';
export const DURATION_LABEL = 'Duration';
/** The empty text of a file list whose filters match nothing. */
export const NO_MATCHING_FILES_TEXT = 'No matching files';
