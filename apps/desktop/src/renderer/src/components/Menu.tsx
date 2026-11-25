import { MoreHorizontal } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { BORDER, ICON_BUTTON } from '../ui';

export interface MenuItem {
  label: string;
  onSelect(): void;
  disabled?: boolean;
  title?: string;
}

interface Props {
  label: string;
  items: MenuItem[];
  icon?: ReactNode;
}

/**
 * A menu button. Opening focuses the menu itself; ↑/↓ (wrapping), Home and End move between the
 * enabled items, Enter or Space selects, Esc or Tab closes. Focus returns to the trigger.
 */
export function Menu({ label, items, icon }: Props) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const menuId = useId();

  useEffect(() => {
    if (open) menuRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

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

  function focusedIndex(): number {
    return itemRefs.current.findIndex((element) => element !== null && element === document.activeElement);
  }

  /** Focuses the next enabled item from `from` in direction `step`; `from` -1 starts at an end. */
  function move(from: number, step: 1 | -1) {
    const n = items.length;
    let index = from;
    for (let tried = 0; tried < n; tried += 1) {
      index = index < 0 ? (step === 1 ? 0 : n - 1) : (index + step + n) % n;
      if (!items[index]!.disabled) {
        itemRefs.current[index]?.focus();
        return;
      }
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        move(focusedIndex(), 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        move(focusedIndex(), -1);
        break;
      case 'Home':
        event.preventDefault();
        move(-1, 1);
        break;
      case 'End':
        event.preventDefault();
        move(-1, -1);
        break;
      case 'Enter':
      case ' ': {
        event.preventDefault();
        const index = focusedIndex();
        if (index >= 0) select(index);
        break;
      }
      case 'Escape':
        // Prevented and stopped so that an enclosing dialog stays open.
        event.preventDefault();
        event.stopPropagation();
        close();
        break;
      case 'Tab':
        event.preventDefault();
        close();
        break;
    }
  }

  return (
    <div className="relative inline-block">
      <button
        ref={triggerRef}
        type="button"
        className={ICON_BUTTON}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        {icon ?? <MoreHorizontal size={16} aria-hidden />}
      </button>
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={label}
          tabIndex={-1}
          onKeyDown={onKeyDown}
          className={`absolute right-0 top-full z-50 mt-1 min-w-44 rounded-control border bg-surface py-1 outline-none ${BORDER}`}
        >
          {items.map((item, index) => (
            <div
              key={item.label}
              ref={(element) => {
                itemRefs.current[index] = element;
              }}
              role="menuitem"
              tabIndex={-1}
              aria-disabled={item.disabled || undefined}
              title={item.title}
              onClick={() => select(index)}
              className="cursor-default whitespace-nowrap px-3 py-1.5 text-sm text-text outline-none hover:bg-raised focus:bg-nav-active aria-disabled:opacity-50 aria-disabled:hover:bg-transparent"
            >
              {item.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
