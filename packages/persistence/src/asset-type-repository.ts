import type { AssetType } from '@assetforge/contracts';
import type { AssetTypeRepository } from '@assetforge/core';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { assetType } from './schema.js';

/**
 * The asset type of a row.
 *
 * @param row the asset type row
 * @returns the asset type
 */
const toAssetType = (row: typeof assetType.$inferSelect): AssetType => ({
  id: row.id,
  key: row.key,
  name: row.name,
  sortOrder: row.sortOrder,
  builtIn: row.builtIn,
  defaultWorkflowTemplateId: row.defaultWorkflowTemplateId,
});

/**
 * The asset type repository over the workspace database.
 *
 * @param database the workspace database
 * @returns the repository
 */
export function createAssetTypeRepository(database: BetterSQLite3Database): AssetTypeRepository {
  return {
    list: () => listTypes(database),
    get: (id) => getType(database, id),
    insertMissing: (types) => insertMissing(database, types),
    setDefaultWorkflowTemplateIfUnset: (typeKey, templateId) =>
      setDefaultWorkflowTemplateIfUnset(database, typeKey, templateId),
  };
}

/**
 * Every asset type by sort order, then name.
 *
 * @param database the workspace database
 * @returns the asset types
 */
async function listTypes(database: BetterSQLite3Database): Promise<AssetType[]> {
  return database
    .select()
    .from(assetType)
    .orderBy(asc(assetType.sortOrder), asc(assetType.name))
    .all()
    .map(toAssetType);
}

/**
 * One asset type.
 *
 * @param database the workspace database
 * @param id the asset type
 * @returns the asset type; null when unknown
 */
async function getType(database: BetterSQLite3Database, id: string): Promise<AssetType | null> {
  const row = database.select().from(assetType).where(eq(assetType.id, id)).get();
  return row ? toAssetType(row) : null;
}

/**
 * Inserts the types whose key does not exist yet, in one transaction.
 *
 * @param database the workspace database
 * @param types the types
 * @returns nothing
 */
async function insertMissing(
  database: BetterSQLite3Database,
  types: Parameters<AssetTypeRepository['insertMissing']>[0],
): Promise<void> {
  if (types.length === 0) return;
  database.transaction((transaction) => {
    for (const type of types) {
      transaction
        .insert(assetType)
        .values({
          id: type.id,
          key: type.key,
          name: type.name,
          sortOrder: type.sortOrder,
          builtIn: type.builtIn,
          defaultWorkflowTemplateId: type.defaultWorkflowTemplateId,
        })
        .onConflictDoNothing({ target: assetType.key })
        .run();
    }
  });
}

/**
 * Sets the type's default workflow template unless it has one.
 *
 * @param database the workspace database
 * @param typeKey the asset type's key
 * @param templateId the template
 * @returns nothing
 */
async function setDefaultWorkflowTemplateIfUnset(
  database: BetterSQLite3Database,
  typeKey: string,
  templateId: string,
): Promise<void> {
  database
    .update(assetType)
    .set({ defaultWorkflowTemplateId: templateId })
    .where(and(eq(assetType.key, typeKey), isNull(assetType.defaultWorkflowTemplateId)))
    .run();
}
