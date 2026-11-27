import {
  ANALYSIS_TAG_LIMIT_MAX,
  ANALYSIS_TAG_LIMIT_MIN,
  type AnalysisPromptPurpose,
  type FileKind,
  type GenerationParameters,
  type GenerationStatus,
  type JobStatus,
  PARALLEL_REQUESTS_MAX,
  PARALLEL_REQUESTS_MIN,
  type ProviderKind,
  type RelationKind,
  type Thinking,
  VISION_TIMEOUT_MAX_SECONDS,
  VISION_TIMEOUT_MIN_SECONDS,
} from '@assetforge/contracts';
import { formatDateTime } from './format';

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
  openai: 'OpenAI-compatible',
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
export const BASE_URL_TITLE = 'Address of the provider server (http or https)';
export const OPENAI_BASE_URL_PLACEHOLDER = 'http://localhost:8000/v1';
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
export const PROVIDER_KIND_TITLE = 'Ollama and OpenAI-compatible providers analyse images, Venice generates them';
export const TEMPERATURE_LABEL = 'Temperature';
export const TEMPERATURE_TITLE = '0 gives the most repeatable answers';
export const TEMPERATURE_INVALID = 'The temperature must be a number from 0 to 2';
export const THINKING_LABEL = 'Thinking';
export const THINKING_TITLE =
  'Sent as think (Ollama) or chat_template_kwargs.enable_thinking (OpenAI-compatible). For other models leave Server default and use Extra parameters';
export const THINKING_LABELS: Record<Thinking, string> = { default: 'Server default', off: 'Off', on: 'On' };
export const MAX_TOKENS_LABEL = 'Max. answer tokens';
export const MAX_TOKENS_TITLE = 'Empty: the server decides';
export const MAX_TOKENS_INVALID = 'The answer tokens must be empty or a whole number from 1 to 100000';
export const EXTRA_PARAMETERS_LABEL = 'Extra parameters';
export const EXTRA_PARAMETERS_TITLE = 'A JSON object merged into every request of this provider';
export const PARALLEL_REQUESTS_LABEL = 'Parallel requests';
export const PARALLEL_REQUESTS_TITLE = 'Analysis requests sent at the same time';
export const PARALLEL_REQUESTS_INVALID = `The parallel requests must be a whole number from ${PARALLEL_REQUESTS_MIN} to ${PARALLEL_REQUESTS_MAX}`;
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
export const PROMPTS_TITLE = 'Analysis prompts';
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
export const ANALYSIS_NEW_PROMPT_LABEL = 'New';
export const NEW_PROMPT_TITLE = 'Adds a prompt with the built-in text';
/** The name of a new prompt: 'New prompt', then 'New prompt 2', … */
export const NEW_PROMPT_NAME = 'New prompt';
export const PROMPT_NAME_LABEL = 'Name';
export const PROMPT_NAME_TITLE = 'Shown in the analysis dialogs; unique within its list';
export const PROMPT_TAG_LIMIT_LABEL = 'Tag limit';
export const PROMPT_TAG_LIMIT_TITLE = `At most this many tags are kept from one answer (${ANALYSIS_TAG_LIMIT_MIN}–${ANALYSIS_TAG_LIMIT_MAX})`;
export const ANALYSIS_PROMPT_TEXT_LABEL = 'Text';
export const ANALYSIS_PROMPT_TEXT_TITLE = 'Sent to the vision model together with the image';
export const SAVE_LABEL = 'Save';
export const RESET_LABEL = 'Reset';
export const RESET_PROMPT_TITLE = 'Replaces the text with the built-in one; the name stays';
export const ANALYSIS_DELETE_PROMPT_TITLE = 'Deletes the prompt; asks first';
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

/** The addresses a file was downloaded from, in the file details column (FileOrigins). */
export const FILE_ORIGINS_LABEL = 'Source';

/** The status text of a succeeded download whose content was already in the workspace. */
export const ALREADY_PRESENT_LABEL = 'Already present';

/** The choice before importing picked ZIP archives (ZipChoiceDialog). */
export const ZIP_ARCHIVE_TITLE = 'ZIP archive';
export const UNPACK_LABEL = 'Unpack';
export const UNPACK_TITLE = 'Imports each file inside the archive';
export const IMPORT_AS_FILE_LABEL = 'Import as file';
export const IMPORT_AS_FILE_TITLE = 'Imports the archive itself as one file';
export const ZIP_CANCEL_TITLE = 'Imports nothing';

/** The progress of a running file import (ImportProgressView). */
export const IMPORT_PROGRESS_LABEL = 'Import progress';
export const IMPORT_CANCEL_LABEL = 'Cancel';
export const IMPORT_CANCEL_TITLE = 'Stops after the current file';

/** '3 of 10'. */
export function importCountText(done: number, total: number): string {
  return `${done} of ${total}`;
}

/** The import from a list of addresses (UrlImportDialog) and its entry buttons. */
export const URL_IMPORT_LABEL = 'Import from URLs';
export const URLS_LABEL = 'URLs';
export const URLS_TITLE = 'One address per line';
export const SKIP_DUPLICATES_LABEL = 'Skip duplicates';
export const SKIP_DUPLICATES_TITLE = 'Identical content is not stored again';
export const IMPORT_LABEL = 'Import';

/** 'At most 5000 addresses at once'. */
export function tooManyUrlsTitle(max: number): string {
  return `At most ${max} addresses at once`;
}

/** The count lines of a started URL import, in their order: 'Queued 3'. */
export const URL_IMPORT_COUNT_LABELS = {
  queued: 'Queued',
  alreadyImported: 'Already imported',
  alreadyQueued: 'Already queued',
  invalid: 'Not usable',
} as const;

/** The import from a gallery through a site profile (SiteImportDialog) and its entry buttons. */
export const SITE_IMPORT_LABEL = 'Import from site';
export const SITE_PROFILE_LABEL = 'Profile';
export const NEW_SITE_PROFILE_OPTION = 'New profile';
export const NEW_SITE_PROFILE_LABEL = 'New';
export const NEW_SITE_PROFILE_TITLE = 'Adds a profile';
export const SITE_PROFILE_NAME_LABEL = 'Name';
export const SITE_ADDRESS_LABEL = 'Site address';
export const SITE_ADDRESS_TITLE = 'Any address of the site; the profile reads only this site and its subdomains';
export const SITE_LABEL = 'Site';
export const THUMBNAILS_XPATH_LABEL = 'Thumbnails XPath';
export const THUMBNAILS_XPATH_TITLE = 'Selects the links of the gallery';
export const PAGINATION_XPATH_LABEL = 'Pagination XPath';
export const PAGINATION_XPATH_TITLE = 'Selects the links to further gallery pages; empty for one page';
export const FILE_XPATH_LABEL = 'File XPath';
export const FILE_XPATH_TITLE = 'Selects the file on a detail page; empty when a gallery link is the file';
export const SITE_KINDS_LABEL = 'Kinds';
export const MIN_SIZE_LABEL = 'Min. size';
export const MIN_SIZE_TITLE = 'In KB; smaller files are not kept';
export const URL_CONTAINS_LABEL = 'URL contains';
export const URL_CONTAINS_TITLE = 'A file address must contain this text, regardless of case';
export const MAX_PAGES_LABEL = 'Max. pages';
export const MAX_PAGES_TITLE = 'Gallery pages read at most';
export const MAX_FILES_LABEL = 'Max. files';
export const MAX_FILES_TITLE = 'Files found at most';
export const SAVE_SITE_PROFILE_TITLE = 'Saves the profile';
export const DELETE_SITE_PROFILE_TITLE = 'Deletes the profile and its login; asks first';
export const LOG_IN_LABEL = 'Log in';
export const LOG_IN_TITLE = 'Opens the site in a window of the app to log in';
export const GALLERY_URL_LABEL = 'Gallery URL';
export const GALLERY_URL_TITLE = 'The first page of the gallery';
export const SITE_TEST_LABEL = 'Test';
export const SITE_TEST_TITLE = 'Shows which files would be imported; downloads nothing';
export const SITE_IMPORT_TITLE = 'Queues the found files; needs a test of the saved profile and this address';
export const CRAWL_PROGRESS_LABEL = 'Test progress';
export const CRAWL_CANCEL_LABEL = 'Cancel';
export const CRAWL_CANCEL_TITLE = 'Stops the test and keeps what was found';
export const FOUND_FILES_LABEL = 'Found files';

/** '3 pages, 40 files'. */
export function crawlProgressText(pages: number, files: number): string {
  return `${pages} pages, ${files} files`;
}

/** 'Delete profile Shop?'. */
export function deleteSiteProfileTitle(name: string): string {
  return `Delete profile ${name}?`;
}

/** The count lines of a test answer, in their order: 'Pages 3'. Pages and Files always, the others above 0. */
export const SITE_CRAWL_COUNT_LABELS = {
  pages: 'Pages',
  files: 'Files',
  duplicates: 'Duplicates',
  filtered: 'Filtered',
  disallowed: 'Disallowed',
  invalid: 'Not usable',
  pageFailures: 'Page failures',
} as const;
export const CRAWL_TRUNCATED_LABELS = { pages: 'Stopped at Max. pages', files: 'Stopped at Max. files' } as const;
export const CRAWL_CANCELLED_LABEL = 'Cancelled';

/** The status text of a succeeded download that the site profile's kinds or minimum size left out. */
export const FILTERED_LABEL = 'Filtered';

/** '2 archives'; the dialog names a single archive by its file name instead. */
export function archiveCountLabel(count: number): string {
  return `${count} archives`;
}

/** The origin of a trashed file that came from the inbox. */
export const INBOX_LABEL = 'Inbox';
export const TRASH_EMPTY_TEXT = 'Trash is empty';
export const DELETED_LABEL = 'Deleted';
export const ORIGIN_LABEL = 'Origin';

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
export const VIDEO_UNPLAYABLE_TEXT = 'This video cannot be played here';
export const OPEN_EXTERNALLY_LABEL = 'Open externally';
export const DURATION_LABEL = 'Duration';

const fileCount = (count: number) => `${count} ${count === 1 ? 'file' : 'files'}`;
const assetCount = (count: number) => `${count} ${count === 1 ? 'asset' : 'assets'}`;
const promptCount = (count: number) => `${count} ${count === 1 ? 'prompt' : 'prompts'}`;

/** The rename tag dialog (RenameTagDialog) and the pencil on an editable tag chip. */
export const RENAME_TAG_TITLE = 'Rename tag';
export const TAG_NAME_LABEL = 'Name';
export const RENAME_LABEL = 'Rename';
export const MERGE_LABEL = 'Merge';

/** The accessible name of the pencil on a chip: 'Rename front view'. */
export function renameTagLabel(displayName: string): string {
  return `${RENAME_LABEL} ${displayName}`;
}

interface TagUsageCounts {
  displayName: string;
  files: number;
  assets: number;
  prompts: number;
}

/** 'front view · 42 files · 3 assets · 1 prompt'. */
export function tagUsageLine(usage: TagUsageCounts): string {
  return `${usage.displayName} · ${fileCount(usage.files)} · ${assetCount(usage.assets)} · ${promptCount(usage.prompts)}`;
}

/** 'Merges with front · 118 files · 5 assets · 0 prompts'. */
export function tagMergeLine(usage: TagUsageCounts): string {
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
export const UPSCALE_TITLE = 'Enlarge this image with the image provider';

/** 'Upscale 4×'. */
export function upscaleLabel(scale: 2 | 4): string {
  return `${UPSCALE_LABEL} ${UPSCALE_SCALE_LABELS[scale]}`;
}
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
export const MODEL_LABEL = 'Model';
export const COPY_PROMPT_FAILED = 'The prompt could not be copied';
/** A source or result link whose file cannot be read. */
export const LINKED_FILE_FAILED = 'This file could not be opened';

/** '16:9 · 2K · Safe mode' for an edit (a value left to the model is not named), 'Upscale 4×' for an upscale. */
export function generationParametersText(parameters: GenerationParameters): string {
  if ('scale' in parameters) return upscaleLabel(parameters.scale);
  const parts = [parameters.aspectRatio, parameters.resolution, parameters.safeMode ? SAFE_MODE_LABEL : `${SAFE_MODE_LABEL} off`];
  return parts.filter((part): part is string => part !== null).join(' · ');
}

/** The type column of the Jobs screen. */
export const JOB_TYPE_LABELS: Record<string, string> = {
  'vision.analyze_file': 'Analysis',
  'image.generate': 'Generation',
  'file.download': 'Download',
};

/** The prompt library (Prompts screen); the analysis prompts of the settings keep their own labels above. */
export const PROMPTS_LABEL = 'Prompts';
export const NEW_PROMPT_LABEL = 'New';
export const PROMPT_TITLE_LABEL = 'Title';
export const PROMPT_DESCRIPTION_LABEL = 'Description';
export const PROMPT_TEXT_LABEL = 'Text';
export const PROMPT_TEXT_TITLE = 'Write {{name}} for a part that changes';
export const PROMPT_VERSION_LABEL = 'Version';
export const USE_VERSION_LABEL = 'Use this version';
export const UNSAVED_PROMPT_TITLE = 'Discard the unsaved changes?';
export const DISCARD_LABEL = 'Discard';
export const DELETE_PROMPT_TITLE = 'Delete this prompt?';
export const SEARCH_PROMPTS_LABEL = 'Search prompts';
export const PROMPT_TAG_FILTER_TITLE = 'Prompts that carry all these tags';
export const PROMPT_TAGS_LABEL = 'Prompt tags';
export const NO_PROMPTS_TEXT = 'No prompts';
export const NO_MATCHING_PROMPTS_TEXT = 'No matching prompts';
export const NO_PROMPT_SELECTED_TEXT = 'No prompt selected';

/** 'v3 · <date and time as the lists format them>'. */
export function promptVersionLabel(number: number, createdAt: string): string {
  return `v${number} · ${formatDateTime(createdAt)}`;
}

/** '1 prompt' / '12 prompts'. */
export function promptCountLabel(count: number): string {
  return promptCount(count);
}

/** Library prompts in the studio form (StudioForm, PromptPicker, SavePromptDialog). */
export const LIBRARY_PROMPT_LABEL = 'Library';
export const LIBRARY_PROMPT_TITLE = 'Choose a prompt from the library';
export const EDIT_PROMPT_TEXT_LABEL = 'Edit text';
export const EDIT_PROMPT_TEXT_TITLE = 'Use the text as a free prompt';
export const SAVE_TO_LIBRARY_LABEL = 'Save to library';
export const VARIABLE_MISSING_TITLE = 'Fill in every variable';
export const NEWER_VERSION_TITLE = 'A newer version exists; click to load it';
export const NEW_LIBRARY_PROMPT_LABEL = 'New prompt';

/** 'Hero shot v3'. */
export function attachedPromptLabel(title: string, number: number): string {
  return `${title} v${number}`;
}

export const ATTACHED_PROMPT_LABEL = 'Library prompt';

/** One 'name: value' per line, as the tooltip of an attached prompt; empty for no values. */
export function promptValuesTitle(values: Readonly<Record<string, string>> | null): string {
  return Object.entries(values ?? {})
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n');
}

/** 'New version of Hero shot'. */
export function newVersionOfLabel(title: string): string {
  return `New version of ${title}`;
}
