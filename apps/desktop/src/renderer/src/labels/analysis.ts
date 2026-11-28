/** The accessible names of the model selects. */
export const MODEL_PURPOSE_LABELS: Record<'tagging' | 'prompt', string> = {
  tagging: 'Tagging model',
  prompt: 'Prompt model',
};

/** The model select of the analysis dialogs. */
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
/**
 * The tooltip of a tagging prompt in the select.
 *
 * @param maxTags the prompt's tag limit
 * @returns 'Tag limit 15'
 */
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
/** The count lines of the start dialog, in their order. */
export const START_COUNTS: readonly {
  key: 'analysable' | 'alreadyAnalysed' | 'alreadyQueued' | 'notAnalysable';
  label: string;
  title: string;
}[] = [
  { key: 'analysable', label: 'To analyse', title: 'Files that will be analysed with this model' },
  {
    key: 'alreadyAnalysed',
    label: 'Already analysed',
    title: 'Files already analysed with this model; skipped unless analysed again',
  },
  { key: 'alreadyQueued', label: 'Already queued', title: 'Files with an analysis that is queued or running' },
  { key: 'notAnalysable', label: 'Not analysable', title: 'Files that are not complete images of a supported type' },
];
