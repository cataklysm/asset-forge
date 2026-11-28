// The texts of the new-project dialog, the project details column, the project screen with its members and
// assignments, and the workflow section of the asset screen.

/** The name input of the new-project dialog. */
export const PROJECT_NAME_LABEL = 'Project name';
/** The description field of a project. */
export const PROJECT_DESCRIPTION_LABEL = 'Description';
/** The submit button of the new-project dialog. */
export const CREATE_PROJECT_LABEL = 'Create';

/** The heading of the details column. */
export const PROJECT_DETAILS_TITLE = 'Project details';
/** The status term of the details list. */
export const PROJECT_DETAILS_STATUS = 'Status';
/** The member count term of the details list. */
export const PROJECT_DETAILS_ASSETS = 'Assets';
/** The image count term of the details list. */
export const PROJECT_DETAILS_IMAGES = 'Images';
/** The name and heading of the matching content section. */
export const MATCHING_CONTENT_LABEL = 'Matching content';
/** The button that shows every matching asset in the gallery. */
export const SHOW_ALL_MATCHING_LABEL = 'Show all';
/** The type term of a matching asset. */
export const MATCHING_TYPE_TERM = 'Type';
/** The status term of a matching asset. */
export const MATCHING_STATUS_TERM = 'Status';

/** The name of the project breadcrumb. */
export const BREADCRUMB_LABEL = 'Breadcrumb';
/** The breadcrumb link back to the projects list. */
export const PROJECTS_BREADCRUMB_LINK = 'Projects';
/** The name input of the project screen. */
export const PROJECT_NAME_FIELD = 'Name';
/** The status select of the project screen. */
export const PROJECT_STATUS_SELECT = 'Status';
/** The name and heading of the members section. */
export const PROJECT_MEMBERS_SECTION = 'Assets';
/** The members section without members. */
export const NO_ASSETS_ASSIGNED = 'No assets assigned';
/** The heading of the asset picker. */
export const ADD_ASSET_LABEL = 'Add asset';

/** The name of the members table. */
export const MEMBERS_TABLE_LABEL = 'Members';
/** The asset column of the members table. */
export const MEMBER_ASSET_COLUMN = 'Asset';
/** The type column of the members table. */
export const MEMBER_TYPE_COLUMN = 'Type';
/** The status column of the members table. */
export const MEMBER_STATUS_COLUMN = 'Status';
/** The assignment column of the members table. */
export const MEMBER_ASSIGNMENT_COLUMN = 'Assignment';
/** The notes column of the members table. */
export const MEMBER_NOTES_COLUMN = 'Notes';
/** The hidden name of the action column. */
export const MEMBER_ACTIONS_COLUMN = 'Actions';
/** The tooltip of the notes toggle of a member without notes. */
export const MEMBER_NOTES_TITLE = 'Notes';
/** The button that removes a member. */
export const REMOVE_MEMBER_LABEL = 'Remove';
/** The tooltip of the button that removes a member. */
export const REMOVE_MEMBER_TITLE = 'Removes the assignment only; the asset and its files are kept';

/** The priority select of an assignment. */
export const ASSIGNMENT_PRIORITY_LABEL = 'Priority';
/** The approval select of an assignment. */
export const ASSIGNMENT_APPROVAL_LABEL = 'Approval';
/** The intended use field of an assignment. */
export const ASSIGNMENT_INTENDED_USE_LABEL = 'Intended use';
/** The notes field of an assignment, and the placeholder of the notes of a workflow step. */
export const NOTES_LABEL = 'Notes';

/** The name of the workflow section. */
export const WORKFLOW_SECTION_LABEL = 'Workflow';
/** The name of the workflow progress bar. */
export const WORKFLOW_PROGRESS_LABEL = 'Workflow progress';
/** The button that removes the workflow. */
export const REMOVE_WORKFLOW_LABEL = 'Remove workflow';
/** The tooltip of the button that removes the workflow. */
export const REMOVE_WORKFLOW_TITLE = 'Step states and notes are deleted; asks first';
/** The marker of an optional step. */
export const OPTIONAL_STEP_LABEL = 'Optional';
/** The template select of a new workflow. */
export const WORKFLOW_TEMPLATE_LABEL = 'Workflow template';
/** The button that starts a workflow. */
export const START_WORKFLOW_LABEL = 'Start workflow';

/**
 * The tooltip of Show all: '42 matching assets'.
 *
 * @param total the number of matching assets
 * @returns the tooltip
 */
export function matchingAssetsTitle(total: number): string {
  return `${total} matching assets`;
}

/**
 * The accessible name of a notes toggle or field: 'Notes for oak'.
 *
 * @param name the asset or step name
 * @returns the name
 */
export function notesForLabel(name: string): string {
  return `Notes for ${name}`;
}

/**
 * The accessible name of a member's Remove: 'Remove oak from Forest'.
 *
 * @param assetName the member asset
 * @param projectName the project
 * @returns the name
 */
export function removeMemberLabel(assetName: string, projectName: string): string {
  return `Remove ${assetName} from ${projectName}`;
}

/**
 * The accessible name of a step's state select: 'State of Modelling'.
 *
 * @param stepName the step
 * @returns the name
 */
export function stepStateLabel(stepName: string): string {
  return `State of ${stepName}`;
}
