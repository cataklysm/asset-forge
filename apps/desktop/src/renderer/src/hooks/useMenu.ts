import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type RefObject,
  type SetStateAction,
} from 'react';

/** The part of a menu item the keyboard handling reads. */
interface Selectable {
  disabled?: boolean;
  onSelect(): void;
}

/** The actions of an open menu that the key handler uses. */
interface MenuActions {
  /** The index of the focused item, or -1. */
  focusedIndex(): number;
  /** Focuses the next enabled item from `from` in direction `step`; `from` -1 starts at an end. */
  move(from: number, step: 1 | -1): void;
  /** Selects the item at `index` unless it is disabled. */
  select(index: number): void;
  /** Closes the menu and focuses the trigger. */
  close(): void;
}

/** What `useMenu` hands to the menu button. */
interface MenuState {
  open: boolean;
  setOpen: Dispatch<SetStateAction<boolean>>;
  triggerRef: RefObject<HTMLButtonElement | null>;
  menuRef: RefObject<HTMLDivElement | null>;
  /** The item elements by index. */
  itemRefs: RefObject<(HTMLDivElement | null)[]>;
  select(index: number): void;
  onKeyDown(event: KeyboardEvent<HTMLDivElement>): void;
}

/**
 * The next enabled item from `from` in direction `step`, wrapping; `from` -1 starts at an end.
 *
 * @param items the menu items
 * @param from the index to start after, or -1
 * @param step the direction
 * @returns the index, or null when every item is disabled
 */
function nextEnabled(items: readonly Selectable[], from: number, step: 1 | -1): number | null {
  const count = items.length;
  let index = from;
  for (let tried = 0; tried < count; tried += 1) {
    if (index < 0) index = step === 1 ? 0 : count - 1;
    else index = (index + step + count) % count;
    if (!items[index]!.disabled) return index;
  }
  return null;
}

/**
 * The keyboard of an open menu: ↑/↓ (wrapping), Home and End move, Enter or Space selects, Esc or Tab closes.
 *
 * @param event the key event of the menu
 * @param menu the actions of the menu
 */
function handleMenuKey(event: KeyboardEvent<HTMLDivElement>, menu: MenuActions): void {
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault();
      menu.move(menu.focusedIndex(), 1);
      break;
    case 'ArrowUp':
      event.preventDefault();
      menu.move(menu.focusedIndex(), -1);
      break;
    case 'Home':
      event.preventDefault();
      menu.move(-1, 1);
      break;
    case 'End':
      event.preventDefault();
      menu.move(-1, -1);
      break;
    case 'Enter':
    case ' ': {
      event.preventDefault();
      const index = menu.focusedIndex();
      if (index >= 0) menu.select(index);
      break;
    }
    case 'Escape':
      // Prevented and stopped so that an enclosing dialog stays open.
      event.preventDefault();
      event.stopPropagation();
      menu.close();
      break;
    case 'Tab':
      event.preventDefault();
      menu.close();
      break;
  }
}

/**
 * Closes an open menu on a pointer press outside the menu and its trigger.
 *
 * @param open whether the menu is open
 * @param menuRef the menu element
 * @param triggerRef the trigger
 * @param setOpen the setter of the open flag
 */
function useOutsideClose(
  open: boolean,
  menuRef: RefObject<HTMLDivElement | null>,
  triggerRef: RefObject<HTMLButtonElement | null>,
  setOpen: Dispatch<SetStateAction<boolean>>,
): void {
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
    // The refs and the setter are stable.
  }, [open]);
}

/**
 * The state and keyboard handling of a menu button. Opening focuses the menu itself; focus returns to the trigger.
 *
 * @param items the menu items; the latest ones are used
 * @returns the open flag, the refs, the selection and the key handler of the menu
 */
export function useMenu(items: readonly Selectable[]): MenuState {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    if (open) menuRef.current?.focus();
  }, [open]);
  useOutsideClose(open, menuRef, triggerRef, setOpen);

  function close() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  function select(index: number) {
    const item = items[index];
    if (item === undefined || item.disabled) return;
    close();
    item.onSelect();
  }

  const actions: MenuActions = {
    focusedIndex: () => itemRefs.current.findIndex((element) => element !== null && element === document.activeElement),
    move(from, step) {
      const index = nextEnabled(items, from, step);
      if (index !== null) itemRefs.current[index]?.focus();
    },
    select,
    close,
  };
  return { open, setOpen, triggerRef, menuRef, itemRefs, select, onKeyDown: (event) => handleMenuKey(event, actions) };
}
