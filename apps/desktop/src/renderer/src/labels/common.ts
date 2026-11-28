/**
 * Turns a stored value into a label: 'in_progress' -> 'In progress'.
 *
 * @param value a snake_case value such as a status or a role
 * @returns the value with spaces and a capital first letter
 */
export function label(value: string): string {
  const text = value.replaceAll('_', ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Buttons shared by several dialogs and lists. */
export const RETRY_LABEL = 'Retry';
export const SAVE_LABEL = 'Save';
export const CANCEL_LABEL = 'Cancel';

/**
 * The count line below the shown failure lines of a result strip: '4900 more failed'.
 *
 * @param count the number of failures not shown
 * @returns the count text
 */
export function moreFailedText(count: number): string {
  return `${count} more failed`;
}
