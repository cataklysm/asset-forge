import type { FileRole } from '@assetforge/contracts';
import { sanitizeFileName } from './file-names.js';

/** Workspace-relative paths; always `/`-separated, never absolute. */
export const MANIFEST_PATH = 'workspace.json';
export const INBOX_DIR = 'inbox';
export const STAGING_DIR = '.assetforge/staging';
export const LAYOUT_DIRS = ['assets', 'inbox', 'exports', '.assetforge/staging'] as const;

export function stagingPath(fileId: string): string {
  return `${STAGING_DIR}/${fileId}.part`;
}

export function inboxPath(fileId: string, originalName: string): string {
  return `${INBOX_DIR}/${fileId}_${sanitizeFileName(originalName)}`;
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

export function assetFilePath(assetId: string, role: FileRole, fileId: string, originalName: string): string {
  return `assets/${assetId}/${ROLE_DIRS[role]}/${fileId}_${sanitizeFileName(originalName)}`;
}
