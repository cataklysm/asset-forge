import {
  ANALYSIS_TAG_LIMIT_MAX,
  ANALYSIS_TAG_LIMIT_MIN,
  type AnalysisPromptPurpose,
  type JobStatus,
  type RelationKind,
} from '@assetforge/contracts';

/** 'in_progress' -> 'In progress'. */
export function label(value: string): string {
  const text = value.replaceAll('_', ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const OUTGOING: Record<RelationKind, string> = {
  uses: 'Uses',
  variant_of: 'Variant of',
  part_of: 'Part of',
  derived_from: 'Derived from',
};

const INCOMING: Record<RelationKind, string> = {
  uses: 'Used by',
  variant_of: 'Has variant',
  part_of: 'Has part',
  derived_from: 'Source of',
};

export function relationLabel(kind: RelationKind, direction: 'outgoing' | 'incoming'): string {
  return (direction === 'outgoing' ? OUTGOING : INCOMING)[kind];
}

/** In the order of the status filter. */
export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  retry_wait: 'Retrying',
  waiting_remote: 'Waiting',
  succeeded: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export function jobStatusLabel(status: JobStatus): string {
  return JOB_STATUS_LABELS[status];
}

/** The accessible names of the model selects. */
export const MODEL_PURPOSE_LABELS: Record<'tagging' | 'prompt', string> = {
  tagging: 'Tagging model',
  prompt: 'Prompt model',
};

export const NO_MODEL_LABEL = 'No model';
export const REFRESH_MODELS_LABEL = 'Refresh models';

/** The skip reasons of an analysis start, as the result strip names them. */
export const SKIP_LABELS: Record<'alreadyAnalysed' | 'alreadyQueued' | 'notAnalysable' | 'notFound', string> = {
  alreadyAnalysed: 'already analysed',
  alreadyQueued: 'already queued',
  notAnalysable: 'not analysable',
  notFound: 'not found',
};

/** The file actions and buttons that start or review an analysis. */
export const ANALYSE_LABEL = 'Analyse';
export const ANALYSE_TITLE = 'Tag this image with the vision model';
export const ANALYSE_SELECTION_TITLE = 'Tag the selected images with the vision model';
export const ANALYSE_ALL_LABEL = 'Analyse all';
export const ANALYSE_ALL_TITLE = 'Analyse the images of this list';
export const ANALYSE_ASSETS_TITLE = 'Analyse the images of the assets in this list';
export const ANALYSE_ASSET_TITLE = 'Analyse the images of this asset';
export const REVIEW_TAGS_LABEL = 'Review tags';
export const REVIEW_TAGS_TITLE = 'Review the proposed tags';
export const IMAGE_TO_PROMPT_LABEL = 'Image to prompt';
export const IMAGE_TO_PROMPT_TITLE = 'Describe this image as a prompt';

/** The proposal filter of a file list and the marker of a file with a proposal. */
export const PROPOSALS_LABEL = 'Proposals';
export const PROPOSALS_TITLE = 'Only files with a tag proposal';
export const PROPOSALS_BLOCK_ANALYSE_ALL = 'Turn off the proposal filter to analyse all';
export const PROPOSAL_MARKER_LABEL = 'Tag proposal';
export const PROPOSAL_MARKER_TITLE = 'Tag proposal waiting for review';

/** The banner of a paused job queue. */
export const RESUME_LABEL = 'Resume';
export const RESUME_TITLE = 'Continue the queued jobs';

/** A failed load of the provider settings; not the same as "not configured". */
export const SETTINGS_LOAD_FAILED = 'The provider settings could not be read';

/** Why the provider or the chosen model lets no analysis or prompt start (see `providerGate`). */
export const START_LOADING = 'The provider settings are loading';
export const NO_VISION_MODEL = 'The provider offers no model that can analyse images';
export const CHOOSE_MODEL = 'Choose a model';
export const MODEL_NOT_LISTED = 'The provider does not offer this model';
export const MODEL_NOT_VISION = 'This model cannot analyse images';

/** The prompt choice of the analysis and prompt dialogs (PromptSelect, `promptGate`). */
export const PROMPT_SELECT_LABEL = 'Prompt';
export const NO_PROMPT_LABEL = 'No prompt';
export const CHOOSE_PROMPT = 'Choose a prompt';
/** The tooltip of a tagging prompt in the select. */
export function tagLimitTitle(maxTags: number): string {
  return `Tag limit ${maxTags}`;
}

/** The start dialog (AnalysisStartDialog). */
export const START_PREVIEW_FAILED = 'The files could not be counted';
export const START_RETRY_PREVIEW_LABEL = 'Count again';
export const START_COUNTING = 'The files are being counted';
export const START_NOTHING_TO_DO = 'Nothing to analyse';
export const START_FORCE_LABEL = 'Analyse again';
export const START_FORCE_TITLE = 'Also analyse the files already analysed with this model';
export const START_COUNTS: readonly {
  key: 'analysable' | 'alreadyAnalysed' | 'alreadyQueued' | 'notAnalysable';
  label: string;
  title: string;
}[] = [
  { key: 'analysable', label: 'To analyse', title: 'Files that will be analysed with this model' },
  { key: 'alreadyAnalysed', label: 'Already analysed', title: 'Files already analysed with this model; skipped unless analysed again' },
  { key: 'alreadyQueued', label: 'Already queued', title: 'Files with an analysis that is queued or running' },
  { key: 'notAnalysable', label: 'Not analysable', title: 'Files that are not complete images of a supported type' },
];

/** The Prompts section of the settings (PromptSettings). */
export const PROMPTS_TITLE = 'Prompts';
export const PROMPT_PURPOSE_LABELS: Record<AnalysisPromptPurpose, string> = {
  tagging: 'Tagging',
  image_prompt: 'Image to prompt',
};
export const PROMPT_PURPOSE_TITLES: Record<AnalysisPromptPurpose, string> = {
  tagging: 'Prompts the tag analysis can send with an image',
  image_prompt: 'Prompts Image to prompt can send with an image',
};
export const PROMPTS_LOAD_FAILED = 'The analysis prompts could not be read';
export const RETRY_LABEL = 'Retry';
export const NEW_PROMPT_LABEL = 'New';
export const NEW_PROMPT_TITLE = 'Adds a prompt with the built-in text';
/** The name of a new prompt: 'New prompt', then 'New prompt 2', … */
export const NEW_PROMPT_NAME = 'New prompt';
export const PROMPT_NAME_LABEL = 'Name';
export const PROMPT_NAME_TITLE = 'Shown in the analysis dialogs; unique within its list';
export const PROMPT_TAG_LIMIT_LABEL = 'Tag limit';
export const PROMPT_TAG_LIMIT_TITLE = `At most this many tags are kept from one answer (${ANALYSIS_TAG_LIMIT_MIN}–${ANALYSIS_TAG_LIMIT_MAX})`;
export const PROMPT_TEXT_LABEL = 'Text';
export const PROMPT_TEXT_TITLE = 'Sent to the vision model together with the image';
export const SAVE_LABEL = 'Save';
export const RESET_LABEL = 'Reset';
export const RESET_PROMPT_TITLE = 'Replaces the text with the built-in one; the name stays';
export const DELETE_PROMPT_TITLE = 'Deletes the prompt; asks first';
export const LAST_PROMPT_TITLE = 'The last prompt cannot be deleted';
export const UNSAVED_CHANGES = 'Unsaved changes';
export const NO_CHANGES = 'No unsaved changes';
export const ENTER_NAME = 'Enter a name';
export const ENTER_TEXT = 'Enter a text';
export const TAG_LIMIT_INVALID = `The tag limit must be a whole number from ${ANALYSIS_TAG_LIMIT_MIN} to ${ANALYSIS_TAG_LIMIT_MAX}`;

/** 'Delete the prompt Detailed?'. */
export function deletePromptTitle(name: string): string {
  return `Delete the prompt ${name}?`;
}

/** The trash: its navigation entry, the Delete, Restore and permanent delete actions and their confirmation. */
export const TRASH_LABEL = 'Trash';
export const DELETE_LABEL = 'Delete';
export const DELETE_TITLE = 'Moves the file to the trash';
export const DELETE_SELECTION_TITLE = 'Moves the files to the trash';
export const RESTORE_LABEL = 'Restore';
export const RESTORE_TITLE = 'Puts the file back where it was';
export const RESTORE_SELECTION_TITLE = 'Puts the files back where they were';
export const PURGE_LABEL = 'Delete permanently';
export const PURGE_TITLE = 'Removes the file from disk; asks first';
export const PURGE_SELECTION_TITLE = 'Removes the files from disk; asks first';
export const EMPTY_TRASH_LABEL = 'Empty trash';
export const EMPTY_TRASH_TITLE = 'Removes every file in the trash from disk; asks first';
export const CANCEL_LABEL = 'Cancel';
/** The origin of a trashed file that came from the inbox. */
export const INBOX_LABEL = 'Inbox';
export const TRASH_EMPTY_TEXT = 'Trash is empty';
export const DELETED_LABEL = 'Deleted';
export const ORIGIN_LABEL = 'Origin';

const fileCount = (count: number) => `${count} ${count === 1 ? 'file' : 'files'}`;

/** 'Delete 1 file permanently?' / 'Delete 12 files permanently?'. */
export function purgeConfirmTitle(count: number): string {
  return `Delete ${fileCount(count)} permanently?`;
}

/** The accessible name of the trash navigation entry with its count: 'Trash, 3 files'. */
export function trashNavLabel(count: number): string {
  return `${TRASH_LABEL}, ${fileCount(count)}`;
}
