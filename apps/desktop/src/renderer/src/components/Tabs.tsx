import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { FOCUS } from '../ui';

/** One tab of `Tabs`. */
interface Tab<T extends string> {
  id: T;
  label: string;
  /** Shown beside the label unless null or absent. */
  count?: number | null;
}

/** The props of `Tabs`. */
interface Props<T extends string> {
  /** The tabs, in order. */
  tabs: Tab<T>[];
  /** The id of the active tab. */
  active: T;
  /** Called with the id of the tab to activate. */
  onChange(id: T): void;
  /** The accessible name of the tab list. */
  label: string;
  /** The panel of the active tab. */
  children: ReactNode;
}

/**
 * The tab index a key moves to: ←/→ by one (not yet wrapped), Home the first, End the last.
 *
 * @param key the pressed key
 * @param current the index of the active tab
 * @param count the number of tabs
 * @returns the index, or null for any other key
 */
function tabTarget(key: string, current: number, count: number): number | null {
  switch (key) {
    case 'ArrowRight':
      return current + 1;
    case 'ArrowLeft':
      return current - 1;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

/**
 * A tab list with one panel for the active tab. ←/→ (wrapping), Home and End activate and focus a tab.
 *
 * @param props the tabs, the active one, the change callback, the list's name and the panel
 * @returns the tab list and the panel
 */
export function Tabs<T extends string>({ tabs, active, onChange, label, children }: Props<T>) {
  const baseId = useId();
  const tabRefs = useRef(new Map<T, HTMLButtonElement>());
  const tabId = (id: T) => `${baseId}-tab-${id}`;
  const panelId = `${baseId}-panel`;

  function activate(index: number) {
    const tab = tabs[(index + tabs.length) % tabs.length];
    if (tab === undefined) return;
    onChange(tab.id);
    tabRefs.current.get(tab.id)?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const current = tabs.findIndex((tab) => tab.id === active);
    const target = tabTarget(event.key, current, tabs.length);
    if (target === null) return;
    event.preventDefault();
    activate(target);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div role="tablist" aria-label={label} onKeyDown={onKeyDown} className="flex gap-1 border-b border-line">
        {tabs.map((tab) => {
          const selected = tab.id === active;
          return (
            <button
              key={tab.id}
              ref={(element) => {
                if (element === null) tabRefs.current.delete(tab.id);
                else tabRefs.current.set(tab.id, element);
              }}
              type="button"
              role="tab"
              id={tabId(tab.id)}
              aria-selected={selected}
              aria-controls={panelId}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(tab.id)}
              className={`-mb-px inline-flex h-9 items-center gap-2 border-b-2 px-3 text-sm ${
                selected ? 'border-accent text-text' : 'border-transparent text-muted hover:text-text'
              } ${FOCUS}`}
            >
              {tab.label}
              {tab.count != null && ' '}
              {tab.count != null && <span className="tabular-nums text-muted">{tab.count}</span>}
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id={panelId}
        aria-labelledby={tabId(active)}
        tabIndex={0}
        className={`flex min-h-0 flex-1 flex-col ${FOCUS}`}
      >
        {children}
      </div>
    </div>
  );
}
