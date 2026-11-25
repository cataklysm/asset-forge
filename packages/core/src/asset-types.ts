import type { AssetType } from '@assetforge/contracts';
import type { WorkspaceDatabase } from './ports.js';
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

/** Adds the built-in types whose key is not present yet; existing rows keep their IDs. */
export async function ensureBuiltInAssetTypes(ctx: {
  database: WorkspaceDatabase;
  newId(): string;
}): Promise<void> {
  const types: AssetType[] = BUILT_IN_ASSET_TYPES.map((t, sortOrder) => ({
    id: ctx.newId(),
    key: t.key,
    name: t.name,
    sortOrder,
    builtIn: true,
    defaultWorkflowTemplateId: null,
  }));
  await ctx.database.assetTypes.insertMissing(types);
}

export function listAssetTypes(s: WorkspaceSession): Promise<AssetType[]> {
  return s.database.assetTypes.list();
}
