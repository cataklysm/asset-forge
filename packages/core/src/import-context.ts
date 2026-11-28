import { SourceNotReadableError } from './errors.js';
import type { ImportContext } from './import-file.js';
import type { SourceFiles } from './ports/source-files.js';
import type { WorkspaceSession } from './session.js';

/** The source files of an import that hands its bytes as a stream (a download or a generation result). */
const NO_SOURCE_FILES: SourceFiles = { open: () => Promise.reject(new SourceNotReadableError()) };

/**
 * The import context of the open workspace: its storage, its files and its image probe, with the session's ids and
 * clock.
 *
 * @param session the open workspace
 * @param sources the source files the import opens
 * @returns the import context
 */
export function importContextOf(session: WorkspaceSession, sources: SourceFiles): ImportContext {
  return {
    storage: session.storage,
    storageId: session.storageId,
    files: session.database.files,
    sources,
    probe: session.imageProbe,
    newId: () => session.newId(),
    now: () => session.now(),
  };
}

/**
 * The import context of an import that never opens a source file, because it hands its body to `importStream`
 * directly.
 *
 * @param session the open workspace
 * @returns the import context, whose source files cannot be opened
 */
export function streamImportContextOf(session: WorkspaceSession): ImportContext {
  return importContextOf(session, NO_SOURCE_FILES);
}
