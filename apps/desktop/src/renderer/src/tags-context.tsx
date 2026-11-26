import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { RenameTagDialog } from './components/RenameTagDialog';
import type { TagRename } from './tag-rename';

export interface TagsState {
  /** Raised after every successful rename or merge. */
  renameToken: number;
  /** The last rename of this session; null before the first. */
  lastRename: TagRename | null;
  /** Opens the shared dialog; null outside a provider. */
  openRename: ((tag: { name: string; displayName: string }) => void) | null;
}

const INERT: TagsState = { renameToken: 0, lastRename: null, openRename: null };

const TagsContext = createContext<TagsState>(INERT);

/** Holds the one rename tag dialog of the workspace and announces every rename or merge. */
export function TagsProvider({ children, onRenamed }: { children: ReactNode; onRenamed?(change: TagRename): void }) {
  const [tag, setTag] = useState<{ name: string; displayName: string } | null>(null);
  const [renamed, setRenamed] = useState<{ token: number; last: TagRename | null }>({ token: 0, last: null });
  const onRenamedRef = useRef(onRenamed);
  onRenamedRef.current = onRenamed;

  const openRename = useCallback((next: { name: string; displayName: string }) => setTag(next), []);
  const handleRenamed = useCallback((change: TagRename) => {
    setRenamed((current) => ({ token: current.token + 1, last: change }));
    onRenamedRef.current?.(change);
  }, []);
  const close = useCallback(() => setTag(null), []);

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

/** The rename state of the surrounding `TagsProvider`; outside one no dialog and no renames. */
export function useTags(): TagsState {
  return useContext(TagsContext);
}

/**
 * Calls `apply` once for every rename that happens while the caller is mounted; a rename from
 * before the mount is not applied.
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
