import type { FileList } from '@assetforge/contracts';
import type { FileQuery } from './ports/file-repositories.js';
import { searchWords } from './search.js';
import { tagName } from './tags.js';
import type { WorkspaceSession } from './session.js';

export function listFiles(s: WorkspaceSession, q: FileQuery): Promise<FileList> {
  const { query, tagNames, ...rest } = q;
  const names = tagNames === undefined ? [] : [...new Set(tagNames.map((t) => tagName(t).name))];
  return s.database.files.list({
    ...rest,
    ...(query !== undefined && searchWords(query).length > 0 && { query }),
    ...(names.length > 0 && { tagNames: names }),
  });
}
