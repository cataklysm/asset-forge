import { MoreHorizontal } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SiteCrawlTaskSummary } from '@assetforge/contracts';
import { formatDateTime, shortUrl } from '../format';
import { useMenu } from '../hooks/useMenu';
import { extractionTitle, processedDownloads } from './extraction-presentation';
import { ExtractionProgress, ExtractionStatus } from './ExtractionStatus';
import { BORDER, FOCUS, ICON_BUTTON_INLINE, MUTED } from '../ui';
import type { MenuItem } from './Menu';
import { crawlTargetLabel } from './SiteCrawlReview';

/** One selectable extraction and its row-scoped actions. */
interface Props {
  task: SiteCrawlTaskSummary;
  selected: boolean;
  items: MenuItem[];
  onSelect(): void;
}

/**
 * A compact extraction card. Right-click, Shift+F10 and the visible menu button share one keyboard-aware menu.
 * The menu lives outside the scrolling list so that cards near its edges never clip the actions.
 * @param props saved summary, selection and scoped actions
 * @returns the list card and its context menu
 */
export function SiteExtractionCard({ task, selected, items, onSelect }: Props) {
  const menu = useMenu(items);
  const menuId = useId();
  const [point, setPoint] = useState({ x: 0, y: 0 });
  const label = `Extraction actions: ${task.galleryUrl}`;

  useLayoutEffect(() => {
    if (!menu.open) return;
    const box = menu.menuRef.current?.getBoundingClientRect();
    if (box === undefined) return;
    const x = Math.max(8, Math.min(point.x, window.innerWidth - box.width - 8));
    const y = Math.max(8, Math.min(point.y, window.innerHeight - box.height - 8));
    if (x !== point.x || y !== point.y) setPoint({ x, y });
  }, [menu.open, menu.menuRef, point.x, point.y]);

  useEffect(() => {
    if (!menu.open) return;
    const close = () => menu.setOpen(false);
    window.addEventListener('resize', close);
    document.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('resize', close);
      document.removeEventListener('scroll', close, true);
    };
  }, [menu.open, menu.setOpen]);

  const openAtButton = () => {
    const rect = menu.triggerRef.current?.getBoundingClientRect();
    if (rect !== undefined) setPoint({ x: rect.left, y: rect.bottom + 4 });
    menu.setOpen(true);
  };

  return (
    <li
      className={`relative shrink-0 rounded-tile border transition-colors ${selected ? 'border-accent/60 bg-accent-soft/60' : 'border-transparent bg-surface/50 hover:border-line hover:bg-raised/60'}`}
      onContextMenu={(event) => {
        event.preventDefault();
        setPoint({ x: event.clientX, y: event.clientY });
        menu.setOpen(true);
      }}
      onKeyDown={(event) => {
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault();
          openAtButton();
        }
      }}
    >
      <button
        type="button"
        aria-label={`Select extraction ${task.galleryUrl}`}
        aria-describedby={`${menuId}-status`}
        aria-pressed={selected}
        className={`flex w-full min-w-0 flex-col gap-2.5 rounded-tile p-3.5 pr-10 text-left ${FOCUS}`}
        onClick={onSelect}
      >
        <span className="w-full truncate text-sm font-semibold capitalize" title={task.galleryUrl}>
          {extractionTitle(task)}
        </span>
        <span
          className={`w-full truncate text-xs ${MUTED}`}
          title={`${shortUrl(task.galleryUrl)} · ${formatDateTime(task.createdAt)}`}
        >
          {task.profileName} · {crawlTargetLabel(task)}
        </span>
        <span id={`${menuId}-status`} className="flex w-full flex-wrap items-center justify-between gap-2">
          <ExtractionStatus task={task} />
          <span className={`text-[11px] tabular-nums ${MUTED}`}>
            {task.downloads == null
              ? `${task.progress.files} files`
              : `${processedDownloads(task)} / ${task.downloads.total}`}
          </span>
        </span>
        <span className="w-full">
          <ExtractionProgress task={task} />
        </span>
      </button>
      <button
        ref={menu.triggerRef}
        type="button"
        className={`absolute right-1.5 top-2 border-transparent bg-transparent ${ICON_BUTTON_INLINE}`}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        aria-controls={menu.open ? menuId : undefined}
        onClick={() => (menu.open ? menu.setOpen(false) : openAtButton())}
      >
        <MoreHorizontal size={16} aria-hidden />
      </button>
      {menu.open &&
        createPortal(
          <div
            ref={menu.menuRef}
            id={menuId}
            role="menu"
            aria-label={label}
            tabIndex={-1}
            onKeyDown={menu.onKeyDown}
            style={{ left: point.x, top: point.y }}
            className={`fixed z-50 min-w-44 rounded-control border bg-surface py-1 shadow-lg outline-none ${BORDER}`}
          >
            {items.map((item, index) => (
              <div
                key={item.label}
                ref={(element) => {
                  menu.itemRefs.current[index] = element;
                }}
                role="menuitem"
                tabIndex={-1}
                aria-disabled={item.disabled || undefined}
                title={item.title}
                onClick={() => menu.select(index)}
                className="cursor-default whitespace-nowrap px-3 py-1.5 text-sm text-text outline-none hover:bg-raised focus:bg-nav-active aria-disabled:opacity-50 aria-disabled:hover:bg-transparent"
              >
                {item.label}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </li>
  );
}
