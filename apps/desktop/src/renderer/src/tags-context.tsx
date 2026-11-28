import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { RenameTagDialog } from './components/RenameTagDialog';
import type { TagRename } from './tag-rename';

/** What `useTags` hands out: the rename signal and the opener of the shared rename dialog. */
export interface TagsState {
  /** Raised after every successful rename or merge. */
  renameToken: number;
  /** The last rename of this session; null before the first. */
  lastRename: TagRename | null;
  /**
   * Opens the shared dialog; null outside a provider. `onRenamed` is called before the signal
   * when this opening ends in a rename, and never when it is cancelled.
   */
  openRename: ((tag: { name: string; displayName: string }, onRenamed?: (change: TagRename) => void) => void) | null;
}

/** The state outside a provider: no dialog and no renames. */
const INERT: TagsState = { renameToken: 0, lastRename: null, openRename: null };

/** Carries the state of the nearest `TagsProvider`. */
const TagsContext = createContext<TagsState>(INERT);

/** The props of `TagsProvider`. */
interface TagsProviderProps {
  /** The part of the UI that may rename tags. */
  children: ReactNode;
  /** Called after every rename or merge, after the opener's own callback. */
  onRenamed?(change: TagRename): void;
}

/**
 * Holds the one rename tag dialog of the workspace and announces every rename or merge.
 *
 * @param props the children and the optional rename callback
 * @returns the children with the context and the dialog
 */
export function TagsProvider({ children, onRenamed }: TagsProviderProps) {
  const [tag, setTag] = useState<{ name: string; displayName: string } | null>(null);
  const [renamed, setRenamed] = useState<{ token: number; last: TagRename | null }>({ token: 0, last: null });
  const onRenamedRef = useRef(onRenamed);
  onRenamedRef.current = onRenamed;

  /** The callback of the current opening of the dialog. */
  const openerRef = useRef<((change: TagRename) => void) | null>(null);

  const openRename = useCallback((next: { name: string; displayName: string }, onOpenerRenamed?: (change: TagRename) => void) => {
    openerRef.current = onOpenerRenamed ?? null;
    setTag(next);
  }, []);
  const handleRenamed = useCallback((change: TagRename) => {
    const opener = openerRef.current;
    openerRef.current = null;
    opener?.(change);
    setRenamed((current) => ({ token: current.token + 1, last: change }));
    onRenamedRef.current?.(change);
  }, []);
  const close = useCallback(() => {
    openerRef.current = null;
    setTag(null);
  }, []);

  const value = useMemo<TagsState>(
    () => ({ renameToken: renamed.token, lastRename: renamed.last, openRename }),
    [renamed, openRename],
  );
  return (
    <TagsContext.Provider value={value}>
      {children}
      <RenameTagDialog tag={tag} onClose={close} onRenamed={handleRenamed} />
    </TagsContext.Provider>
  );
}

/**
 * The rename state of the surrounding `TagsProvider`; outside one no dialog and no renames.
 *
 * @returns the state of the nearest provider
 */
export function useTags(): TagsState {
  return useContext(TagsContext);
}

/**
 * Calls `apply` once for every rename that happens while the caller is mounted; a rename from
 * before the mount is not applied.
 *
 * @param apply called with each rename; the latest function is used
 */
export function useRenamed(apply: (change: TagRename) => void): void {
  const { lastRename } = useTags();
  const applied = useRef(lastRename);
  const applyRef = useRef(apply);
  applyRef.current = apply;
  useEffect(() => {
    if (lastRename === null || lastRename === applied.current) return;
    applied.current = lastRename;
    applyRef.current(lastRename);
  }, [lastRename]);
}
