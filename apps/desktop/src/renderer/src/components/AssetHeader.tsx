import { AssetStatusSchema, FileRoleSchema, type AssetDetail, type FileRole } from '@assetforge/contracts';
import { ApiError, call, describeError } from '../api';
import type { ImportProgressState } from '../import-progress';
import { ANALYSE_ASSET_TITLE, ANALYSE_LABEL, label, SITE_IMPORT_LABEL, URL_IMPORT_LABEL } from '../labels';
import { ALERT, BUTTON, PAGE_TITLE, SELECT } from '../ui';
import { CommitInput } from './CommitInput';
import { ImportStatus } from './ImportProgressView';
import { SourceList } from './SourceList';
import { TagRow } from './TagRow';

// The header of the asset screen: name, type, status, the import and analysis controls, description, tags and sources.

const ROLES = FileRoleSchema.options;

/** The patch of `assets:update`. */
export type AssetPatch = Parameters<typeof call<'assets:update'>>[1]['patch'];

/** Runs a mutation, shows its failure in the screen's alert and then rejects, so that an input keeps its text. */
export type Reported = (action: () => Promise<unknown>, describe?: (error: unknown) => string) => Promise<void>;

/**
 * An unusable address is refused with its own fixed message, which the generic one would hide.
 *
 * @param error the failure of adding a source
 * @returns the shown message
 */
function describeSourceError(error: unknown): string {
  return error instanceof ApiError && error.code === 'validation_failed' ? error.message : describeError(error);
}

/** The import and analysis controls of the header. */
interface ImportControlsProps {
  /** The role imported files get. */
  importRole: FileRole;
  /** Chooses another role. */
  onImportRoleChange(role: FileRole): void;
  /** Whether an import runs; disables the import buttons. */
  importing: boolean;
  /** The running import's progress and cancel. */
  importProgress: ImportProgressState;
  /** Picks and imports files. */
  onImportFiles(): void;
  /** Opens the URL import dialog. */
  onUrlImport(): void;
  /** Opens the site import dialog. */
  onSiteImport(): void;
  /** Why Analyse is blocked; null when it is not. */
  analysisBlocked: string | null;
  /** Starts the analysis of the asset. */
  onAnalyse(): void;
}

/** The props of the header. */
interface Props extends ImportControlsProps {
  /** The id of the screen's asset; the tag and source calls name it. */
  assetId: string;
  /** The shown asset. */
  asset: AssetDetail;
  /** The asset types for the type select; null while loading. */
  types: Awaited<ReturnType<typeof call<'assetTypes:list'>>> | null;
  /** Saves a change of name, type, status or description; resolves to whether it succeeded. */
  onSave(patch: AssetPatch): Promise<boolean>;
  /** Shows the asset a mutation returned. */
  onAssetChange(asset: AssetDetail): void;
  /** Runs a mutation of tags or sources with its failure shown. */
  reported: Reported;
  /** The messages shown below the header. */
  errors: readonly string[];
}

/**
 * The asset header.
 *
 * @param props the asset, its types, the import and analysis state, the mutations and the errors
 * @returns the header
 */
export function AssetHeader(props: Props) {
  const { asset, types, onSave, errors } = props;
  return (
    <header className="space-y-2">
      <h1 className="sr-only">{asset.name}</h1>
      <div className="flex flex-wrap items-center gap-2">
        <CommitInput
          label="Name"
          variant="inline"
          className={`h-12 min-w-64 flex-1 ${PAGE_TITLE}`}
          value={asset.name}
          maxLength={200}
          onCommit={(name) => onSave({ name })}
        />
        <select
          className={SELECT}
          aria-label="Type"
          value={asset.typeId}
          onChange={(event) => void onSave({ typeId: event.target.value })}
        >
          {(types ?? []).map((type) => (
            <option key={type.id} value={type.id}>
              {type.name}
            </option>
          ))}
        </select>
        <select
          className={SELECT}
          aria-label="Status"
          value={asset.status}
          onChange={(event) => void onSave({ status: AssetStatusSchema.parse(event.target.value) })}
        >
          {AssetStatusSchema.options.map((status) => (
            <option key={status} value={status}>
              {label(status)}
            </option>
          ))}
        </select>
        <ImportControls {...props} />
      </div>
      <AssetFields {...props} />
      {errors.map((message) => (
        <p key={message} role="alert" className={ALERT}>
          {message}
        </p>
      ))}
    </header>
  );
}

/**
 * The role for imported files, Import files, the URL and site import, the import progress and Analyse.
 *
 * @param props the import and analysis state and actions
 * @returns the controls
 */
function ImportControls(props: ImportControlsProps) {
  const { importRole, importing, importProgress, analysisBlocked } = props;
  return (
    <div className="ml-auto flex items-center gap-2">
      <select
        className={SELECT}
        aria-label="Role for imported files"
        title="Import as"
        value={importRole}
        onChange={(event) => props.onImportRoleChange(FileRoleSchema.parse(event.target.value))}
      >
        {ROLES.map((role) => (
          <option key={role} value={role}>
            {label(role)}
          </option>
        ))}
      </select>
      <button type="button" className={BUTTON} disabled={importing} onClick={props.onImportFiles}>
        Import files
      </button>
      <button type="button" className={BUTTON} disabled={importing} onClick={props.onUrlImport}>
        {URL_IMPORT_LABEL}
      </button>
      <button type="button" className={BUTTON} disabled={importing} onClick={props.onSiteImport}>
        {SITE_IMPORT_LABEL}
      </button>
      <ImportStatus state={importProgress} />
      <button
        type="button"
        className={BUTTON}
        disabled={analysisBlocked !== null}
        title={analysisBlocked ?? ANALYSE_ASSET_TITLE}
        onClick={props.onAnalyse}
      >
        {ANALYSE_LABEL}
      </button>
    </div>
  );
}

/**
 * Description, asset tags and sources side by side.
 *
 * @param props the asset, whether an import runs and the mutations
 * @returns the row
 */
function AssetFields({ assetId, asset, importing, onSave, onAssetChange, reported }: Props) {
  return (
    <div className="flex flex-wrap items-start gap-4">
      <CommitInput
        label="Description"
        multiline
        variant="inline"
        placeholder="Description"
        className="min-w-64 flex-1"
        value={asset.description}
        maxLength={5000}
        onCommit={(description) => onSave({ description })}
      />
      <div className="min-w-64 flex-1">
        <TagRow
          label="Asset tags"
          kind="asset"
          tags={asset.tags}
          onAdd={async (name) => onAssetChange(await call('assets:addTag', { assetId, name }))}
          onRemove={async (name) => onAssetChange(await call('assets:removeTag', { assetId, name }))}
        />
      </div>
      <div className="min-w-64 flex-1">
        <SourceList
          sources={asset.sources}
          disabled={importing}
          onAdd={(url) =>
            reported(async () => onAssetChange(await call('assets:addSource', { assetId, url })), describeSourceError)
          }
          onRemove={(sourceId) =>
            reported(async () => onAssetChange(await call('assets:removeSource', { assetId, sourceId })))
          }
          onOpen={(sourceId) => reported(() => call('assets:openSource', { assetId, sourceId }))}
        />
      </div>
    </div>
  );
}
