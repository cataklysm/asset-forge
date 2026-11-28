import { MoreHorizontal } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { useMenu } from '../hooks/useMenu';
import { BORDER, BUTTON, ICON_BUTTON } from '../ui';

/** One entry of a `Menu`. */
export interface MenuItem {
  /** The text of the entry; also its key, so unique within one menu. */
  label: string;
  /** Called when the entry is chosen; the menu is closed first. */
  onSelect(): void;
  /** A disabled entry is skipped by the arrow keys and cannot be chosen. */
  disabled?: boolean;
  /** The tooltip. */
  title?: string;
}

/** The props of `Menu`. */
interface Props {
  /** The accessible name of the trigger and the menu, and the trigger's tooltip. */
  label: string;
  /** The entries, in order. */
  items: MenuItem[];
  /** The trigger icon; three dots by default. */
  icon?: ReactNode;
  /** Tab index of the trigger; -1 keeps it out of the tab order (e.g. inside a roving tab index list). */
  tabIndex?: number;
  /** Which trigger edge the popup lines up with; `end` grows leftwards, `start` rightwards. */
  align?: 'start' | 'end';
  /** Whether the popup opens below or above the trigger. */
  side?: 'bottom' | 'top';
  /** `labelled` shows the label as text next to the icon; `icon` (the default) shows the icon only. */
  trigger?: 'icon' | 'labelled';
}

/**
 * A menu button. Opening focuses the menu itself; ↑/↓ (wrapping), Home and End move between the
 * enabled items, Enter or Space selects, Esc or Tab closes. Focus returns to the trigger.
 *
 * @param props the label, the items, the trigger look and the popup placement
 * @returns the trigger and, while open, the menu
 */
export function Menu({ label, items, icon, tabIndex, align = 'end', side = 'bottom', trigger = 'icon' }: Props) {
  const { open, setOpen, triggerRef, menuRef, itemRefs, select, onKeyDown } = useMenu(items);
  const menuId = useId();

  return (
    <div className="relative inline-block">
      <button
        ref={triggerRef}
        type="button"
        className={trigger === 'labelled' ? BUTTON : ICON_BUTTON}
        aria-label={trigger === 'labelled' ? undefined : label}
        title={label}
        tabIndex={tabIndex}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        {icon ?? <MoreHorizontal size={16} aria-hidden />}
        {trigger === 'labelled' && label}
      </button>
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={label}
          tabIndex={-1}
          onKeyDown={onKeyDown}
          className={`absolute ${align === 'start' ? 'left-0' : 'right-0'} ${side === 'top' ? 'bottom-full mb-1' : 'top-full mt-1'} z-50 min-w-44 rounded-control border bg-surface py-1 outline-none ${BORDER}`}
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
