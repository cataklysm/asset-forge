import type { FileRole } from '@assetforge/contracts';
import { sanitizeFileName } from './file-names.js';

// Workspace-relative paths; always `/`-separated, never absolute.

/** The workspace manifest. */
export const MANIFEST_PATH = 'workspace.json';
/** Where files without an asset live. */
export const INBOX_DIR = 'inbox';
/** Where an import writes before the checksum is verified. */
export const STAGING_DIR = '.assetforge/staging';
/** Where trashed files wait until they are restored or purged. */
export const TRASH_DIR = '.assetforge/trash';
/** The directories every workspace has. */
export const LAYOUT_DIRS = ['assets', 'inbox', 'exports', STAGING_DIR, TRASH_DIR] as const;

/**
 * Where an import of a file is staged.
 *
 * @param fileId the file
 * @returns the workspace-relative path
 */
export function stagingPath(fileId: string): string {
  return `${STAGING_DIR}/${fileId}.part`;
}

/**
 * Where a file without an asset lives.
 *
 * @param fileId the file
 * @param originalName the name it was imported with
 * @returns the workspace-relative path
 */
export function inboxPath(fileId: string, originalName: string): string {
  return `${INBOX_DIR}/${fileId}_${sanitizeFileName(originalName)}`;
}

/**
 * Where a trashed file lives.
 *
 * @param fileId the file
 * @param originalName the name it was imported with
 * @returns the workspace-relative path
 */
export function trashPath(fileId: string, originalName: string): string {
  return `${TRASH_DIR}/${fileId}_${sanitizeFileName(originalName)}`;
}

/** The directory inside an asset's folder that holds the files of a role. */
export const ROLE_DIRS: Record<FileRole, string> = {
  reference: 'references',
  concept: 'references',
  generated: 'generations',
  model: 'models',
  working: 'models',
  texture: 'textures',
  final: 'miscellaneous',
  other: 'miscellaneous',
};

/**
 * Where a file of an asset lives.
 *
 * @param assetId the asset
 * @param role the file's role
 * @param fileId the file
 * @param originalName the name it was imported with
 * @returns the workspace-relative path
 */
export function assetFilePath(assetId: string, role: FileRole, fileId: string, originalName: string): string {
  return `assets/${assetId}/${ROLE_DIRS[role]}/${fileId}_${sanitizeFileName(originalName)}`;
}
