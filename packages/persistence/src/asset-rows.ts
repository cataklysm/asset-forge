import type { Asset } from '@assetforge/contracts';
import { asset } from './schema.js';

/**
 * The asset of a row; shared by every repository that reads asset rows.
 *
 * @param row the asset row
 * @returns the asset
 */
export const toAsset = (row: typeof asset.$inferSelect): Asset => ({
  id: row.id,
  name: row.name,
  typeId: row.typeId,
  description: row.description,
  status: row.status,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});
