import { useEffect, useState } from 'react';
import type { PausedHost } from '@assetforge/contracts';
import { call } from '../api';

/** The answer while no host is paused by a browser check or the profiles cannot be read. */
const NO_SITES: ReadonlySet<string> = new Set();

/**
 * The sites of the site profiles, read whenever the set of hosts a browser check paused changes; empty while none is
 * paused for that reason or the list cannot be read.
 *
 * @param pausedHosts the paused download hosts of the job summary
 * @returns the profile sites among which Open site is offered
 */
export function useCheckHosts(pausedHosts: readonly PausedHost[]): ReadonlySet<string> {
  const [sites, setSites] = useState<ReadonlySet<string>>(NO_SITES);
  const checked = pausedHosts
    .filter((entry) => entry.reason === 'download_browser_check')
    .map((entry) => entry.host)
    .join(' ');
  useEffect(() => {
    if (checked === '') {
      setSites(NO_SITES);
      return;
    }
    let current = true;
    call('sites:list', {}).then(
      ({ profiles }) => {
        if (current) setSites(new Set(profiles.map((profile) => profile.site)));
      },
      () => {
        if (current) setSites(NO_SITES);
      },
    );
    return () => {
      current = false;
    };
  }, [checked]);
  return sites;
}
