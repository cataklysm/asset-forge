import type { AssetType } from '@assetforge/contracts';
import type { WorkspaceDatabase } from './ports/workspace-database.js';
import type { WorkspaceSession } from './session.js';

/** The asset types every workspace starts with; the index is the sort order. */
export const BUILT_IN_ASSET_TYPES: readonly { key: string; name: string }[] = [
  { key: 'character', name: 'Character' },
  { key: 'creature', name: 'Creature' },
  { key: 'landscape', name: 'Landscape' },
  { key: 'building', name: 'Building' },
  { key: 'vehicle', name: 'Vehicle' },
  { key: 'prop', name: 'Prop' },
  { key: 'material', name: 'Material' },
  { key: 'other', name: 'Other' },
];

/**
 * Adds the built-in types whose key is not present yet; existing rows keep their IDs, and an id is drawn only for
 * a missing type.
 *
 * @param context the open database and the id source
 * @returns resolves once the missing types are inserted
 */
export async function ensureBuiltInAssetTypes(context: {
  database: WorkspaceDatabase;
  newId(): string;
}): Promise<void> {
  const present = new Set((await context.database.assetTypes.list()).map((type) => type.key));
  const types: AssetType[] = [];
  BUILT_IN_ASSET_TYPES.forEach((type, sortOrder) => {
    if (present.has(type.key)) return;
    types.push({
      id: context.newId(),
      key: type.key,
      name: type.name,
      sortOrder,
      builtIn: true,
      defaultWorkflowTemplateId: null,
    });
  });
  if (types.length > 0) await context.database.assetTypes.insertMissing(types);
}

/**
 * The asset types of the workspace.
 *
 * @param session the open workspace
 * @returns them in sort order
 */
export function listAssetTypes(session: WorkspaceSession): Promise<AssetType[]> {
  return session.database.assetTypes.list();
}
