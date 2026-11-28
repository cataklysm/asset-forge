// The single-image result dialog (AnalysisResultDialog, AnalysisResultParts).

/** The heading of the proposed tags. */
export const PROPOSED_TAGS_LABEL = 'Proposed tags';
/** Tooltip of a proposed tag. */
export const PROPOSED_TAG_TITLE = 'AI tag';
/** Tooltip of the model that made a proposal. */
export const PROPOSAL_MODEL_TITLE = 'Model';
/** The marker of a stale proposal. */
export const OUT_OF_DATE_LABEL = 'Out of date';
/** Applies the proposed tags. */
export const ACCEPT_LABEL = 'Accept';
/** Shown when an accept would act on a proposal other than the one on screen. */
export const PROPOSAL_CHANGED = 'The proposal has changed. Review it again.';
/** Shown when a start queued nothing for the file. */
export const NOT_ANALYSABLE = 'This file cannot be analysed';
/** Tooltip of the disabled Accept and of the marker of a stale proposal. */
export const STALE_TITLE = 'The file changed after the analysis';

/** Tooltip of the start button of the three analysis dialogs while the analysis prompts load (`promptGate`). */
export const PROMPTS_LOADING = 'The analysis prompts are loading';

// The start dialog (AnalysisStartDialog).

/** The title of the start dialog. */
export const ANALYSIS_START_TITLE = 'Analyse';
/** Starts the analysis. */
export const START_LABEL = 'Start';

// The Image to prompt dialog (PromptDialog).

/** The title of the Image to prompt dialog. */
export const PROMPT_DIALOG_TITLE = 'Image to prompt';
/** Shown when the main process is already describing another image. */
export const PROMPT_BUSY_MESSAGE = 'Another prompt is being generated';
/** Shown when the clipboard refused the text. */
export const COPY_FAILED_MESSAGE = 'The text could not be copied';
/** Tooltip of Generate while a request runs. */
export const GENERATING_TITLE = 'The prompt is being generated';
/** Tooltip of Generate without a file. */
export const NO_FILE_TITLE = 'No image to describe';
/** Asks the provider to describe the image. */
export const DESCRIBE_LABEL = 'Generate';
/** Copies the generated text. */
export const COPY_LABEL = 'Copy';
/** The label of the generated text. */
export const PROMPT_RESULT_LABEL = 'Generated prompt';
/** Tooltip of Generate when the provider lists no model that takes images. */
export const NO_DESCRIBE_MODEL = 'The provider offers no model that can describe images';
/** Tooltip of Generate when the chosen model does not take images. */
export const MODEL_NOT_DESCRIBE = 'This model cannot describe images';
