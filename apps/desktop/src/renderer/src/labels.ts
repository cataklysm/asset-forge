import {
  ANALYSIS_TAG_LIMIT_MAX,
  ANALYSIS_TAG_LIMIT_MIN,
  type AnalysisPromptPurpose,
  type GenerationStatus,
  type JobStatus,
  type ProviderKind,
  type RelationKind,
  VISION_TIMEOUT_MAX_SECONDS,
  VISION_TIMEOUT_MIN_SECONDS,
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

/** The state of a provider entry, as the provider select and the settings show it. */
export const PROVIDER_STATE_LABELS = {
  checking: 'checking',
  ready: 'ready',
  unreachable: 'not reachable',
  unauthorized: 'key refused',
  no_vision_model: 'no vision model',
  no_edit_model: 'no edit model',
  error: 'error',
} as const;

/** The kind of a provider entry (ProviderSettings). */
export const PROVIDER_KIND_LABELS: Record<ProviderKind, string> = {
  ollama: 'Ollama',
  venice: 'Venice',
};
export const PROVIDER_KIND_LABEL = 'Kind';
export const EDIT_MODEL_LABEL = 'Edit model';

/** The provider select (ProviderSelect). */
export const PROVIDER_LABEL = 'Provider';
export const NO_PROVIDER = 'No provider';

/** 'RunPod — ready'. */
export function providerOptionLabel(name: string, state: string): string {
  return `${name} — ${state}`;
}

/** Moving waiting jobs to another provider (MoveJobsDialog), the pause banner and the Jobs screen. */
export const MOVE_JOBS_LABEL = 'Move jobs';
export const MOVE_JOBS_TITLE = 'Moves the waiting jobs of a provider to another one';
export const MOVE_LABEL = 'Move';
export const MOVE_FROM = 'From';
export const MOVE_TO = 'To';
export const WAITING_COUNT = (n: number) => `${n} waiting`;
export const NO_WAITING_JOBS = 'No waiting jobs';
export const COUNTING_WAITING_JOBS = 'The waiting jobs are being counted';
export const JOBS_PROVIDER_HEADER = 'Provider';
export const ALL_PROVIDERS = 'All providers';
export const REMOVED_PROVIDER = 'Removed provider';

/** The name of a job lane: its stored name, else `No provider` for id null and `Removed provider` otherwise. */
export function laneLabel(id: string | null, name: string | null): string {
  return name ?? (id === null ? NO_PROVIDER : REMOVED_PROVIDER);
}

/** Why nothing can start while the selected provider is asked for its models (see `providerGate`). */
export const PROVIDER_CHECKING = 'The provider is being checked';

/** The provider section of the settings (ProviderSettings). */
export const PROVIDERS_TITLE = 'Vision providers';
export const PROVIDERS_LIST_LABEL = 'Providers';
export const NEW_PROVIDER_LABEL = 'New';
export const NEW_PROVIDER_TITLE = 'Adds a provider';
export const PROVIDER_LIMIT_TITLE = 'No more than 10 providers';
export const DELETE_PROVIDER_TITLE = 'Deletes the provider; asks first';
export const PROVIDER_NAME_LABEL = 'Name';
export const PROVIDER_NAME_TITLE = 'Shown in the analysis dialogs and the jobs; unique';
export const BASE_URL_LABEL = 'Base URL';
export const BASE_URL_TITLE = 'Address of the Ollama-compatible vision server (http or https)';
export const API_KEY_LABEL = 'API key';
export const API_KEY_TITLE = 'Sent as a bearer token to this server only; a stored key is never shown again';
export const NO_KEY_STORE_TITLE = 'The system credential store is not available, so no key can be saved';
export const KEY_STORED = 'Stored';
export const REMOVE_KEY_LABEL = 'Remove key';
export const REMOVE_KEY_TITLE = 'Deletes the stored key on save';
export const TIMEOUT_LABEL = 'Timeout (s)';
export const TIMEOUT_TITLE = `Seconds to wait for one answer (${VISION_TIMEOUT_MIN_SECONDS}–${VISION_TIMEOUT_MAX_SECONDS})`;
export const TIMEOUT_INVALID = `The timeout must be a whole number from ${VISION_TIMEOUT_MIN_SECONDS} to ${VISION_TIMEOUT_MAX_SECONDS}`;
export const TAGGING_MODEL_TITLE = 'Model that tags images';
export const PROMPT_MODEL_TITLE = 'Model that writes a prompt from an image';
export const EDIT_MODEL_TITLE = 'Model that edits and generates images';
export const PROVIDER_KIND_TITLE = 'Ollama-compatible providers analyse images, Venice generates them';
export const PROVIDER_STATE_LABEL = 'State';
export const FROM_ENVIRONMENT = 'From environment';
export const FROM_ENVIRONMENT_TITLE = 'The provider comes from the environment and cannot be changed here';
export const ENTER_BASE_URL = 'Enter a base URL';

/** 'Delete the provider RunPod?'. */
export function deleteProviderTitle(name: string): string {
  return `Delete the provider ${name}?`;
}

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

/** The sources block in the asset header (SourceList). */
export const SOURCES_LABEL = 'Sources';
export const ADD_SOURCE_PLACEHOLDER = 'Add URL';
export const COPY_SOURCE_TITLE = 'Copy URL';
export const REMOVE_SOURCE_TITLE = 'Remove source';
export const COPY_SOURCE_FAILED = 'The URL could not be copied';

/** The choice before importing picked ZIP archives (ZipChoiceDialog). */
export const ZIP_ARCHIVE_TITLE = 'ZIP archive';
export const UNPACK_LABEL = 'Unpack';
export const UNPACK_TITLE = 'Imports each file inside the archive';
export const IMPORT_AS_FILE_LABEL = 'Import as file';
export const IMPORT_AS_FILE_TITLE = 'Imports the archive itself as one file';
export const ZIP_CANCEL_TITLE = 'Imports nothing';

/** '2 archives'; the dialog names a single archive by its file name instead. */
export function archiveCountLabel(count: number): string {
  return `${count} archives`;
}

/** The origin of a trashed file that came from the inbox. */
export const INBOX_LABEL = 'Inbox';
export const TRASH_EMPTY_TEXT = 'Trash is empty';
export const DELETED_LABEL = 'Deleted';
export const ORIGIN_LABEL = 'Origin';

const fileCount = (count: number) => `${count} ${count === 1 ? 'file' : 'files'}`;
const assetCount = (count: number) => `${count} ${count === 1 ? 'asset' : 'assets'}`;

/** The rename tag dialog (RenameTagDialog) and the pencil on an editable tag chip. */
export const RENAME_TAG_TITLE = 'Rename tag';
export const TAG_NAME_LABEL = 'Name';
export const RENAME_LABEL = 'Rename';
export const MERGE_LABEL = 'Merge';

/** The accessible name of the pencil on a chip: 'Rename front view'. */
export function renameTagLabel(displayName: string): string {
  return `${RENAME_LABEL} ${displayName}`;
}

/** 'front view · 42 files · 3 assets'. */
export function tagUsageLine(usage: { displayName: string; files: number; assets: number }): string {
  return `${usage.displayName} · ${fileCount(usage.files)} · ${assetCount(usage.assets)}`;
}

/** 'Merges with front · 118 files · 5 assets'. */
export function tagMergeLine(usage: { displayName: string; files: number; assets: number }): string {
  return `Merges with ${tagUsageLine(usage)}`;
}

/** 'Delete 1 file permanently?' / 'Delete 12 files permanently?'. */
export function purgeConfirmTitle(count: number): string {
  return `Delete ${fileCount(count)} permanently?`;
}

/** The accessible name of the trash navigation entry with its count: 'Trash, 3 files'. */
export function trashNavLabel(count: number): string {
  return `${TRASH_LABEL}, ${fileCount(count)}`;
}

/** The entry points of the generation studio and the dialog's own title. */
export const GENERATE_LABEL = 'Generate from image';
export const GENERATE_TITLE = 'Edit this image with an image model';
export const UPSCALE_LABEL = 'Upscale';
export const UPSCALE_SCALE_LABELS: Record<2 | 4, string> = { 2: '2×', 4: '4×' };
export const NO_IMAGE_PROVIDER_TITLE = 'Add an image provider in Settings first';
export const STUDIO_TITLE = 'Studio';

/** The form of the studio (GenerationStudio). */
export const PROMPT_LABEL = PROMPT_SELECT_LABEL;
export const RECENT_PROMPTS_LABEL = 'Recent';
export const ASPECT_LABEL = 'Aspect';
export const RESOLUTION_LABEL = 'Resolution';
export const SAFE_MODE_LABEL = 'Safe mode';
export const GENERATE_BUTTON = 'Generate';
/** The aspect (or resolution) option that leaves the model's default. */
export const MODEL_DEFAULT_OPTION = 'Default';
export const PROMPT_LENGTH_TITLE = 'The prompt must have 1 to 8000 characters';
export const PROMPT_TOO_LONG_TITLE = 'The prompt is longer than this model allows';
export const SOURCE_IMAGE_LABEL = 'Source image';
export const CLOSE_LABEL = 'Close';
export const UPSCALES_LABEL = 'Upscales';

/** 'Upscale 2×'. */
export function upscaleLabel(scale: 2 | 4): string {
  return `${UPSCALE_LABEL} ${UPSCALE_SCALE_LABELS[scale]}`;
}

/** The results of the studio; `RETRY_LABEL` above is shared. */
export const RESULTS_LABEL = 'Results';
export const USE_SETTINGS_LABEL = 'Use settings';
export const OPEN_LABEL = 'Open';
export const REMOVE_LABEL = 'Remove';
export const TRASHED_MARK = 'In the trash';
export const DELETED_MARK = DELETED_LABEL;
/** A pending generation shows its live job state as queued or running. */
export const GENERATION_STATUS_LABELS: Record<GenerationStatus | 'running', string> = {
  pending: JOB_STATUS_LABELS.queued,
  running: JOB_STATUS_LABELS.running,
  succeeded: JOB_STATUS_LABELS.succeeded,
  failed: JOB_STATUS_LABELS.failed,
  cancelled: JOB_STATUS_LABELS.cancelled,
};

/** The generation block of the file details column. */
export const GENERATED_FROM_LABEL = 'Generated from';
export const COPY_PROMPT_TITLE = 'Copy prompt';
export const PARAMETERS_LABEL = 'Parameters';

/** The type column of the Jobs screen. */
export const JOB_TYPE_LABELS: Record<string, string> = {
  'vision.analyze_file': 'Analysis',
  'image.generate': 'Generation',
};
