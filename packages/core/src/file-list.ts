import type { FileList } from '@assetforge/contracts';
import type { FileQuery } from './ports/file-repositories.js';
import { searchWords } from './search.js';
import { tagName } from './tags.js';
import type { WorkspaceSession } from './session.js';

/**
 * A page of files. A query without a search word is left out, and the tag names are normalised and made unique.
 *
 * @param session the open workspace
 * @param fileQuery the filter, search and page of the list
 * @returns the page of files
 */
export function listFiles(session: WorkspaceSession, fileQuery: FileQuery): Promise<FileList> {
  const { query, tagNames, ...rest } = fileQuery;
  const names = tagNames === undefined ? [] : [...new Set(tagNames.map((name) => tagName(name).name))];
  return session.database.files.list({
    ...rest,
    ...(query !== undefined && searchWords(query).length > 0 && { query }),
    ...(names.length > 0 && { tagNames: names }),
  });
}
