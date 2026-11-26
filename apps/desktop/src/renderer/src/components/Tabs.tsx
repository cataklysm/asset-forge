import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { FOCUS } from '../ui';

interface Tab<T extends string> {
  id: T;
  label: string;
  count?: number | null;
}

interface Props<T extends string> {
  tabs: Tab<T>[];
  active: T;
  onChange(id: T): void;
  label: string;
  children: ReactNode;
}

/** A tab list with one panel for the active tab. ←/→ (wrapping), Home and End activate and focus a tab. */
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
    const target =
      event.key === 'ArrowRight'
        ? current + 1
        : event.key === 'ArrowLeft'
          ? current - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? tabs.length - 1
              : null;
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
      <div role="tabpanel" id={panelId} aria-labelledby={tabId(active)} tabIndex={0} className={`flex min-h-0 flex-1 flex-col ${FOCUS}`}>
        {children}
      </div>
    </div>
  );
}
