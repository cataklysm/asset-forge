import { useCallback, useState } from 'react';
import {
  NO_FILE_FILTERS,
  NO_FILTERS,
  NO_PROJECT_FILTERS,
  renameInFilters,
  type AssetListState,
  type AssetTab,
  type InboxListState,
  type ProjectListState,
  type TrashListState,
} from '../list-state';
import type { TagRename } from '../tag-rename';

/** The list state of the workspace screens, kept while the user navigates. */
export interface ShellState {
  assetList: AssetListState;
  projectList: ProjectListState;
  inboxList: InboxListState;
  trashList: TrashListState;
  assetTab: AssetTab;
}

/** The state of a newly opened workspace. */
const INITIAL_SHELL: ShellState = {
  assetList: { filters: NO_FILTERS, scrollOffset: 0, openedIndex: null, selectedId: null },
  projectList: { filters: NO_PROJECT_FILTERS, scrollOffset: 0, openedIndex: null, selectedId: null },
  inboxList: { filters: NO_FILE_FILTERS, scrollOffset: 0 },
  trashList: { filters: NO_FILE_FILTERS, scrollOffset: 0 },
  assetTab: 'files',
};

/** What `useShellState` hands out: the state, one setter per part and the rename of filter tags. */
interface ShellStateHandle {
  shell: ShellState;
  setAssetList(assetList: AssetListState): void;
  setProjectList(projectList: ProjectListState): void;
  setInboxList(inboxList: InboxListState): void;
  setTrashList(trashList: TrashListState): void;
  setAssetTab(assetTab: AssetTab): void;
  /** A renamed tag in the filters of every list, mounted or not; the lists reload themselves. Stable. */
  renameInShell(change: TagRename): void;
}

/**
 * A renamed tag in the filters of one list.
 *
 * @param list the list state
 * @param change the finished rename
 * @returns a copy with renamed filters, or `list` itself when they are unchanged
 */
function renameInList<S extends { filters: { tagNames: string[] } }>(list: S, change: TagRename): S {
  const filters = renameInFilters(list.filters, change);
  return filters === list.filters ? list : { ...list, filters };
}

/**
 * The list state of the workspace screens; it lives in the shell so it survives navigation and is dropped with the workspace.
 *
 * @returns the state, its setters and the rename of filter tags
 */
export function useShellState(): ShellStateHandle {
  const [shell, setShell] = useState<ShellState>(INITIAL_SHELL);
  const setAssetList = (assetList: AssetListState) => setShell((current) => ({ ...current, assetList }));
  const setProjectList = (projectList: ProjectListState) => setShell((current) => ({ ...current, projectList }));
  const setInboxList = (inboxList: InboxListState) => setShell((current) => ({ ...current, inboxList }));
  const setTrashList = (trashList: TrashListState) => setShell((current) => ({ ...current, trashList }));
  const setAssetTab = (assetTab: AssetTab) => setShell((current) => ({ ...current, assetTab }));

  const renameInShell = useCallback((change: TagRename) => {
    setShell((current) => ({
      ...current,
      assetList: renameInList(current.assetList, change),
      projectList: renameInList(current.projectList, change),
      inboxList: renameInList(current.inboxList, change),
      trashList: renameInList(current.trashList, change),
    }));
  }, []);

  return { shell, setAssetList, setProjectList, setInboxList, setTrashList, setAssetTab, renameInShell };
}
