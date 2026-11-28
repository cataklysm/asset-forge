import { useEffect, useState } from 'react';
import { call } from '../api';

/**
 * Preview of the directory a new workspace will get; the main process owns the naming rule.
 * A later name or location drops an earlier answer, and a failed request shows no preview.
 *
 * @param parentPath the chosen location, or null
 * @param trimmedName the trimmed workspace name
 * @returns the directory, or null while there is none
 */
export function useCreatePathPreview(parentPath: string | null, trimmedName: string): string | null {
  const [targetPath, setTargetPath] = useState<string | null>(null);
  useEffect(() => {
    if (parentPath === null || trimmedName === '') {
      setTargetPath(null);
      return;
    }
    let active = true;
    call('workspace:resolveCreatePath', { name: trimmedName, parentPath }).then(
      (value) => {
        if (active) setTargetPath(value);
      },
      () => {
        if (active) setTargetPath(null);
      },
    );
    return () => {
      active = false;
    };
  }, [parentPath, trimmedName]);
  return targetPath;
}
