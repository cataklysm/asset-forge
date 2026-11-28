import { useState } from 'react';
import { MAX_PROVIDERS, type ProviderList, type ProviderView, type SaveProvider } from '@assetforge/contracts';
import { ApiError, describeError } from '../api';
import {
  DELETE_LABEL,
  FROM_ENVIRONMENT,
  FROM_ENVIRONMENT_TITLE,
  NEW_PROVIDER_LABEL,
  NEW_PROVIDER_TITLE,
  PROVIDER_LIMIT_TITLE,
  PROVIDERS_LIST_LABEL,
  PROVIDERS_TITLE,
  SETTINGS_LOAD_FAILED,
  deleteProviderTitle,
} from '../labels';
import { useProviders } from '../provider-context';
import { useExclusiveRun } from '../hooks/useExclusiveRun';
import { ALERT, BUTTON, BUTTON_INLINE, MUTED, SECTION_TITLE } from '../ui';
import { ConfirmDialog } from './ConfirmDialog';
import { ProviderEditor } from './ProviderEditor';
import { SettingsLoadState } from './SettingsLoadState';

/** The selection of the editor for an entry that is not saved yet; never a provider id. */
const NEW = 'new';

/**
 * The host's fixed message of a refusal; other failures as `describeError` puts them.
 *
 * @param error the failure
 * @returns the message
 */
function messageOf(error: unknown): string {
  return error instanceof ApiError ? error.message : describeError(error);
}

/** The entry the editor shows. */
interface Selection {
  /** The selected saved entry; null for none or a new one. */
  selected: ProviderView | null;
  /** The editor shows an entry that is not saved yet. */
  editingNew: boolean;
}

/**
 * The entry the editor shows: the chosen one, else the first; a new one when chosen or when there is none.
 *
 * @param list the provider list
 * @param selectedId the chosen entry, `NEW` or null
 * @returns the selection
 */
function selectionOf(list: ProviderList, selectedId: string | null): Selection {
  const providers = list.providers;
  const selected = selectedId === NEW ? null : (providers.find((entry) => entry.id === selectedId) ?? providers[0] ?? null);
  const editingNew = selected === null && (selectedId === NEW || (providers.length === 0 && !list.fromEnvironment));
  return { selected, editingNew };
}

/**
 * Saves an entry, hands the answer to the editor and selects a new entry.
 *
 * @param save the save of the provider context
 * @param input the request
 * @param done takes the saved entry
 * @param select selects an entry
 * @returns resolves once saved; rejects with the refusal
 */
async function saveEntry(
  save: (input: SaveProvider) => Promise<ProviderView>,
  input: SaveProvider,
  done: (view: ProviderView) => void,
  select: (id: string) => void,
): Promise<void> {
  const view = await save(input);
  done(view);
  if (input.id === undefined) select(view.id);
}

/**
 * Deletes an entry; the confirmation closes either way and the selection falls back to the first.
 *
 * @param remove the delete of the provider context
 * @param id the entry
 * @param closeConfirm closes the confirmation
 * @param clearSelection drops the selection
 * @returns resolves once deleted; rejects with the refusal
 */
async function deleteEntry(
  remove: (id: string) => Promise<void>,
  id: string,
  closeConfirm: () => void,
  clearSelection: () => void,
): Promise<void> {
  try {
    await remove(id);
  } finally {
    closeConfirm();
  }
  clearSelection();
}

/** The props of `EntryColumn`. */
interface EntryColumnProps {
  list: ProviderList;
  selection: Selection;
  busy: boolean;
  select(id: string): void;
}

/**
 * The entries in store order and the action that starts a new one.
 *
 * @param props the list, the selection and the select handler
 */
function EntryColumn({ list, selection, busy, select }: EntryColumnProps) {
  const locked = list.fromEnvironment;
  const atLimit = list.providers.length >= MAX_PROVIDERS;
  return (
    <div className="flex w-64 shrink-0 flex-col gap-2">
      <ul className="flex flex-col gap-1" aria-label={PROVIDERS_LIST_LABEL}>
        {list.providers.map((entry) => (
          <li key={entry.id} className="flex flex-col">
            <button
              type="button"
              className={BUTTON_INLINE}
              aria-pressed={!selection.editingNew && entry.id === selection.selected?.id}
              disabled={locked || busy}
              onClick={() => select(entry.id)}
            >
              <span className="min-w-0 flex-1 truncate text-left">{entry.name}</span>
            </button>
          </li>
        ))}
      </ul>
      <div>
        <button
          type="button"
          className={BUTTON}
          title={atLimit ? PROVIDER_LIMIT_TITLE : NEW_PROVIDER_TITLE}
          disabled={busy || locked || atLimit}
          onClick={() => select(NEW)}
        >
          {NEW_PROVIDER_LABEL}
        </button>
      </div>
    </div>
  );
}

/**
 * The provider section of the settings: the entries in store order and an in-place editor of the
 * selected one. Read-only when the environment sets the entry.
 */
export function ProviderSettings() {
  const { list, loading, failed, reload, save, remove } = useProviders();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const { busy, error, setError, run } = useExclusiveRun(messageOf);

  /**
   * Shows the entry `id` (or `NEW`) in the editor and drops the last refusal.
   *
   * @param id the entry or `NEW`
   */
  const select = (id: string) => {
    setError(null);
    setSelectedId(id);
  };

  /**
   * Deletes the selected entry after the confirmation.
   *
   * @param selected the entry the confirmation was shown for
   */
  const confirmDelete = (selected: ProviderView | null) => {
    if (selected === null) return;
    const target = selected;
    void run(() => deleteEntry(remove, target.id, () => setConfirming(false), () => setSelectedId(null)));
  };

  const selection = list === null ? null : selectionOf(list, selectedId);

  return (
    <section className="flex max-w-4xl flex-col gap-4">
      <div className="flex items-center gap-3">
        <h3 className={SECTION_TITLE}>{PROVIDERS_TITLE}</h3>
        {list?.fromEnvironment === true && (
          <span className={`text-sm ${MUTED}`} title={FROM_ENVIRONMENT_TITLE}>
            {FROM_ENVIRONMENT}
          </span>
        )}
      </div>
      {list === null || selection === null ? (
        <SettingsLoadState
          failed={failed && !loading}
          failedMessage={SETTINGS_LOAD_FAILED}
          onRetry={() => void reload().catch(() => {})}
        />
      ) : (
        <div className="flex flex-col gap-4">
          {error !== null && (
            <p role="alert" className={ALERT}>
              {error}
            </p>
          )}
          <div className="flex items-start gap-6">
            <EntryColumn list={list} selection={selection} busy={busy} select={select} />
            {(selection.selected !== null || selection.editingNew) && (
              <ProviderEditor
                key={selection.editingNew ? NEW : selection.selected!.id}
                entry={selection.editingNew ? null : selection.selected}
                list={list}
                busy={busy}
                onSave={(input, done) => run(() => saveEntry(save, input, done, setSelectedId))}
                onDelete={() => setConfirming(true)}
              />
            )}
          </div>
          <ConfirmDialog
            open={confirming && selection.selected !== null && !selection.editingNew}
            title={selection.selected === null ? '' : deleteProviderTitle(selection.selected.name)}
            confirmLabel={DELETE_LABEL}
            busy={busy}
            onCancel={() => setConfirming(false)}
            onConfirm={() => confirmDelete(selection.selected)}
          />
        </div>
      )}
    </section>
  );
}
