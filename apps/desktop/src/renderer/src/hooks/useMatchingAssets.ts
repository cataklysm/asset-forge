import type { AssetList } from '@assetforge/contracts';
import { useEffect, useState } from 'react';
import { call, describeError } from '../api';
import { useTags } from '../tags-context';

/** The most matching assets the projects screen shows for one project. */
export const MATCHING_LIMIT = 20;

/** The answer for one request key: the assets, or the message of the failed request. */
export type Matching = { key: string; list: AssetList } | { key: string; error: string };

/** What `useMatchingAssets` hands to the details column. */
interface MatchingAssets {
  /** The key of the current selection and tags, or null when nothing is asked. */
  requestKey: string | null;
  /** The answer for `requestKey`, or null while it is outstanding. */
  current: Matching | null;
}

/**
 * The member assets of a project that carry all filter tags; a rename asks again under the same
 * key, so the shown answer stays until the new one arrives.
 *
 * @param projectId the selected project, or null
 * @param tagNames the tag filter; none asks for nothing
 * @returns the request key and the answer that belongs to it
 */
export function useMatchingAssets(projectId: string | null, tagNames: readonly string[]): MatchingAssets {
  const [matching, setMatching] = useState<Matching | null>(null);
  const { renameToken } = useTags();
  const tagKey = JSON.stringify(tagNames);
  const requestKey = projectId === null || tagNames.length === 0 ? null : `${projectId}|${tagKey}`;

  useEffect(() => {
    if (requestKey === null || projectId === null) return;
    let active = true;
    const names = JSON.parse(tagKey) as string[];
    call('assets:list', { projectId, tagNames: names, limit: MATCHING_LIMIT, offset: 0 }).then(
      (list) => {
        if (active) setMatching({ key: requestKey, list });
      },
      (error: unknown) => {
        if (active) setMatching({ key: requestKey, error: describeError(error) });
      },
    );
    return () => {
      active = false;
    };
    // A rename asks again under the same key, so the shown answer stays until the new one arrives.
  }, [requestKey, projectId, tagKey, renameToken]);

  // An answer for an earlier selection or other tags is never shown.
  const current = matching !== null && matching.key === requestKey ? matching : null;
  return { requestKey, current };
}
