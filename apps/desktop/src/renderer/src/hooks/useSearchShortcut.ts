import { useEffect, type RefObject } from 'react';

/**
 * Moves the focus to the search field inside `scope` on Ctrl+F (without Shift or Alt).
 *
 * @param event the key event of the document
 * @param scope the element that holds the page, or null before it mounted
 */
function focusSearchField(event: KeyboardEvent, scope: HTMLElement | null): void {
  if (!event.ctrlKey || event.shiftKey || event.altKey || event.key.toLowerCase() !== 'f') return;
  const field = scope?.querySelector<HTMLElement>('[data-search-field]');
  if (field === null || field === undefined) return;
  event.preventDefault();
  field.focus();
}

/**
 * Ctrl+F anywhere in the window focuses the search field of the page (`data-search-field`).
 *
 * @param scopeRef the element that holds the page; read on every key press
 */
export function useSearchShortcut(scopeRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      focusSearchField(event, scopeRef.current);
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
    // The ref object is stable; its current element is read on every key press.
  }, []);
}
