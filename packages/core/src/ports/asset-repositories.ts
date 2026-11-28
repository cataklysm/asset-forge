import type {
  Asset,
  AssetDetail,
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

// The asset rows of a workspace: the asset types, the assets with their covers, their relations and their source
// URLs.

/** The asset types of a workspace; the built-in ones are inserted on open. */
export interface AssetTypeRepository {
  /**
   * Every asset type.
   *
   * @returns the types by sortOrder, then name
   */
  list(): Promise<AssetType[]>;
  /**
   * One asset type.
   *
   * @param id the type
   * @returns the type; null for an unknown id
   */
  get(id: string): Promise<AssetType | null>;
  /**
   * Inserts the types that are not there yet; rows whose key already exists are skipped.
   *
   * @param types the types to make sure of
   */
  insertMissing(types: AssetType[]): Promise<void>;
  /**
   * Sets the default template of the type with `typeKey` unless it already has one; no-op for an unknown key.
   *
   * @param typeKey the stable key of the type
   * @param templateId the workflow template
   */
  setDefaultWorkflowTemplateIfUnset(typeKey: string, templateId: string): Promise<void>;
}

/** What an asset list asks for: the filters and the page. */
export interface AssetQuery extends Page {
  /** Only assets of this type. */
  typeId?: string;
  /** Only assets in this status. */
  status?: AssetStatus;
  /** Only assets assigned to this project. */
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
  /** The cover file; null when the asset has none. */
  coverFileId: string | null;
  /** True when the file was chosen by hand, false for the automatic one. */
  coverIsChosen: boolean;
}

/** The assets of a workspace. */
export interface AssetRepository {
  /**
   * Inserts a new asset.
   *
   * @param asset the row
   */
  insert(asset: Asset): Promise<void>;
  /**
   * One asset.
   *
   * @param id the asset
   * @returns the asset; null for an unknown id
   */
  get(id: string): Promise<Asset | null>;
  /**
   * Writes exactly the given fields.
   *
   * @param id the asset
   * @param patch the changed fields and the new updated_at
   * @returns the updated asset; null for an unknown id
   */
  update(
    id: string,
    patch: Partial<Pick<Asset, 'name' | 'description' | 'typeId' | 'status'>> & { updatedAt: string },
  ): Promise<Asset | null>;
  /**
   * One page of assets by name (case-insensitive), then id; every item carries its effective `coverFileId`.
   *
   * @param filter the filters and the page
   * @returns the page and the total
   */
  list(filter: AssetQuery): Promise<AssetList>;
  /**
   * The effective cover of an asset.
   *
   * @param assetId the asset
   * @returns the cover; null when the asset does not exist
   */
  getCover(assetId: string): Promise<AssetCover | null>;
  /**
   * The asset with its effective cover, its own tags and its sources, read as one snapshot.
   *
   * @param assetId the asset
   * @returns the detail; null when the asset does not exist
   */
  getDetail(assetId: string): Promise<AssetDetail | null>;
  /**
   * Stores the chosen cover in one guarded write: a chosen file must be attached to the asset, complete, outside
   * the trash and have a thumbnail (a previewable image or a video).
   *
   * @param assetId the asset
   * @param fileId the chosen file; `null` returns to the automatic one
   * @param updatedAt the asset's new updated_at
   * @returns whether the asset was written; false for an unknown asset or a file that cannot be the cover
   */
  setCover(assetId: string, fileId: string | null, updatedAt: string): Promise<boolean>;
}

/** What identifies a relation: both ends and its kind. */
export interface RelationKey {
  /** The asset the relation starts at. */
  fromAssetId: string;
  /** The asset the relation points to. */
  toAssetId: string;
  /** What the relation says. */
  kind: RelationKind;
}

/** The typed relations between assets. */
export interface AssetRelationRepository {
  /**
   * Inserts a relation.
   *
   * @param relation the row
   * @returns false if it already exists
   */
  insert(relation: AssetRelation): Promise<boolean>;
  /**
   * Deletes a relation.
   *
   * @param key both ends and the kind
   * @returns false if there was none
   */
  remove(key: RelationKey): Promise<boolean>;
  /**
   * The relations of one asset in both directions.
   *
   * @param assetId the asset
   * @returns outgoing first, then incoming; each by kind, then the other asset's name
   */
  listForAsset(assetId: string): Promise<AssetRelationView[]>;
}

/** Source URLs of assets; an asset carries a URL at most once (compared as stored, i.e. as normalised `href`). */
export interface AssetSourceRepository {
  /**
   * The sources of one asset.
   *
   * @param assetId the asset
   * @returns its sources by createdAt, then id
   */
  listByAsset(assetId: string): Promise<AssetSource[]>;
  /**
   * One source with the asset it belongs to.
   *
   * @param id the source
   * @returns the source; null for an unknown id
   */
  get(id: string): Promise<(AssetSource & { assetId: string }) | null>;
  /**
   * How many sources an asset has, for the limit per asset.
   *
   * @param assetId the asset
   * @returns the number of sources
   */
  countByAsset(assetId: string): Promise<number>;
  /**
   * One transaction: adds a source to an asset and sets the asset's `updatedAt` to the source's `createdAt`.
   *
   * @param source the new row; the URL already normalised
   * @returns false, writing nothing, when the asset already has this URL
   */
  insert(source: { id: string; assetId: string; url: string; createdAt: string }): Promise<boolean>;
  /**
   * One transaction: deletes a source and sets the `updatedAt` of the asset it belonged to.
   *
   * @param id the source
   * @param updatedAt the asset's new `updatedAt`
   * @returns false, writing nothing, when no row has this id
   */
  remove(id: string, updatedAt: string): Promise<boolean>;
}
