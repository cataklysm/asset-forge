// Focus rules of the virtual rows: when a pending item focus may still be applied or is dropped, and how an item that lost
// the focus by changing its element (a placeholder turning into a Retry button) gets it back.

/** An item focus that waits for the item's element to be rendered. */
export interface PendingFocus {
  /** The item to focus. */
  index: number;
  /** The element that had the focus when the item focus was asked for; null for none. */
  from: Element | null;
  /**
   * The id of the item to focus (its element's `data-item-id`); when given, the item is looked for by id, so
   * a list that changed its order meanwhile never focuses another item at the same position.
   */
  id?: string | null;
}

/** What `pendingTarget` found: the element to focus, nothing yet (wait), or that the focus is to be dropped. */
export type PendingTarget = HTMLElement | 'wait' | 'drop';

/**
 * The element a pending item focus goes to. Without an id it is the element at the index. With an id it is
 * the rendered element of that item; while the element at the index is not a loaded item yet (a placeholder
 * or Retry) the focus waits, and once a loaded other item stands there the focus is dropped.
 *
 * @param container the scrolling element of the rows
 * @param pending the pending focus
 * @returns the element, `wait` or `drop`
 */
export function pendingTarget(container: HTMLElement, pending: PendingFocus): PendingTarget {
  const atIndex = container.querySelector<HTMLElement>(`[data-index="${pending.index}"]`);
  if (pending.id === undefined || pending.id === null) return atIndex ?? 'wait';
  for (const element of container.querySelectorAll<HTMLElement>('[data-item-id]')) {
    if (element.getAttribute('data-item-id') === pending.id) return element;
  }
  return atIndex?.hasAttribute('data-item-id') ? 'drop' : 'wait';
}

/** The user inputs after which a pending item focus by id is dropped, so a row never takes the focus late. */
const USER_INPUT_EVENTS = ['keydown', 'wheel', 'touchmove', 'pointerdown'] as const;

/**
 * Calls `onInput` once, on the first key press, wheel turn, touch scroll or pointer press of the user,
 * wherever it happens.
 *
 * @param onInput called on the first input
 * @returns a function that stops listening
 */
export function onFirstUserInput(onInput: () => void): () => void {
  const controller = new AbortController();
  const handle = () => {
    controller.abort();
    onInput();
  };
  for (const type of USER_INPUT_EVENTS) {
    window.addEventListener(type, handle, { capture: true, passive: true, signal: controller.signal });
  }
  return () => controller.abort();
}

/**
 * Drops a pending item focus by id on the user's first input (see `onFirstUserInput`): the item may load
 * long after the user has started doing something else.
 *
 * @param pendingFocus the pending item focus; left alone when it has no id or was replaced meanwhile
 * @returns a function that stops listening
 */
export function dropPendingOnUserInput(pendingFocus: { current: PendingFocus | null }): () => void {
  const pending = pendingFocus.current;
  if (pending === null || pending.id === undefined || pending.id === null) return () => undefined;
  return onFirstUserInput(() => {
    if (pendingFocus.current === pending) pendingFocus.current = null;
  });
}

/** The item element that had the focus while a render was computed. */
export interface FocusedItem {
  /** The focused element. */
  element: HTMLElement;
  /** Its item index. */
  index: number;
}

/** The elements that can take the focus without a `tabindex`. */
const NATIVELY_FOCUSABLE = 'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea';

/**
 * Whether the focus currently sits nowhere: on the body or on no element.
 *
 * @returns true when nothing has the focus
 */
function focusIsNowhere(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body;
}

/**
 * Whether an element can hold the focus.
 *
 * @param element the element
 * @returns true when it is attached and focusable
 */
function canHoldFocus(element: Element): boolean {
  return element.isConnected && (element.hasAttribute('tabindex') || element.matches(NATIVELY_FOCUSABLE));
}

/**
 * Whether a pending item focus may still move the focus: the user has not put it anywhere else meanwhile.
 *
 * @param container the scrolling element of the rows
 * @param pending the pending focus
 * @returns true when the focus is nowhere, inside the rows or still where it was when the focus was asked for
 */
export function mayTakeFocus(container: HTMLElement, pending: PendingFocus): boolean {
  const active = document.activeElement;
  return focusIsNowhere() || active === pending.from || container.contains(active);
}

/**
 * The item element that has the focus now; read while a render is computed, so the commit after it can tell
 * whether that element lost the focus.
 *
 * @param container the scrolling element of the rows; null before it is mounted
 * @returns the focused item, or null when no item has the focus
 */
export function focusedItem(container: HTMLElement | null): FocusedItem | null {
  const active = document.activeElement;
  if (container === null || !(active instanceof HTMLElement) || !container.contains(active)) return null;
  const attribute = active.getAttribute('data-index');
  const index = attribute === null ? Number.NaN : Number(attribute);
  return Number.isInteger(index) ? { element: active, index } : null;
}

/**
 * The element that should take over the focus of an item whose element changed in the last commit: the
 * element now standing for the same item, when the old one was removed or can no longer be focused and the
 * focus has not gone anywhere else.
 *
 * @param container the scrolling element of the rows; null when unmounted
 * @param before the item that had the focus while the render was computed
 * @returns the element to focus, or null to leave the focus alone
 */
export function focusSuccessor(container: HTMLElement | null, before: FocusedItem | null): HTMLElement | null {
  if (container === null || before === null) return null;
  const { element, index } = before;
  if (canHoldFocus(element) && element.getAttribute('data-index') === String(index)) return null;
  const active = document.activeElement;
  if (!focusIsNowhere() && active !== element) return null;
  const successor = container.querySelector<HTMLElement>(`[data-index="${index}"]`);
  return successor !== null && successor !== element && canHoldFocus(successor) ? successor : null;
}
