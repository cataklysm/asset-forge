import type {
  Asset,
  AssetList,
  AssetRelation,
  AssetRelationView,
  AssetSource,
  AssetStatus,
  AssetType,
  FileKind,
  FileRole,
  RelationKind,
} from '@assetforge/contracts';
import type { Page } from './page.js';

export interface AssetTypeRepository {
  list(): Promise<AssetType[]>; // by sortOrder, then name
  get(id: string): Promise<AssetType | null>;
  insertMissing(types: AssetType[]): Promise<void>; // skips rows whose key already exists
  /** Sets the default template of the type with `typeKey` unless it already has one; no-op for an unknown key. */
  setDefaultWorkflowTemplateIfUnset(typeKey: string, templateId: string): Promise<void>;
}

export interface AssetQuery extends Page {
  typeId?: string;
  status?: AssetStatus;
  projectId?: string;
  /** Free text; the repository matches word prefixes. Absent when the text has no words. */
  query?: string;
  /** Normalised, distinct tag names; each must be carried by the asset or by one of its complete files. */
  tagNames?: string[];
  /** Has at least one complete file with this role. */
  fileRole?: FileRole;
  /** Has at least one complete file of this kind. */
  fileKind?: FileKind;
}

/** Effective cover of an asset: the chosen file, else the automatic one (see `automaticCover`), else null. */
export interface AssetCover {
  coverFileId: string | null;
  coverIsChosen: boolean;
}

export interface AssetRepository {
  insert(asset: Asset): Promise<void>;
  get(id: string): Promise<Asset | null>;
  update(
    id: string,
    patch: Partial<Pick<Asset, 'name' | 'description' | 'typeId' | 'status'>> & { updatedAt: string },
  ): Promise<Asset | null>;
  /** By name (case-insensitive), then id; every item carries its effective `coverFileId`. */
  list(q: AssetQuery): Promise<AssetList>;
  getCover(assetId: string): Promise<AssetCover | null>; // null when the asset does not exist
  /** Stores the chosen cover (`null` returns to the automatic one) without validating it; no-op for an unknown asset. */
  setCover(assetId: string, fileId: string | null, updatedAt: string): Promise<void>;
}

export interface RelationKey {
  fromAssetId: string;
  toAssetId: string;
  kind: RelationKind;
}

export interface AssetRelationRepository {
  insert(r: AssetRelation): Promise<boolean>; // false if it already exists
  remove(key: RelationKey): Promise<boolean>;
  listForAsset(assetId: string): Promise<AssetRelationView[]>; // outgoing first, then incoming; each by kind, then other.name
}

/** Source URLs of assets; an asset carries a URL at most once (compared as stored, i.e. as normalised `href`). */
export interface AssetSourceRepository {
  listByAsset(assetId: string): Promise<AssetSource[]>; // by createdAt, then id
  get(id: string): Promise<(AssetSource & { assetId: string }) | null>;
  countByAsset(assetId: string): Promise<number>;
  /** False, writing nothing, when the asset already has this URL. */
  insert(row: { id: string; assetId: string; url: string; createdAt: string }): Promise<boolean>;
  /** False when no row has this id. */
  remove(id: string): Promise<boolean>;
}
