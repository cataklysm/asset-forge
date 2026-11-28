import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import type { ProviderChoice } from '../provider-choice';
import type { StudioSession } from '../studio-session';
import { fieldsOf, freshFields, type PendingModel, type StudioFields } from '../studio-fields';
import { readSafeMode } from '../studio-state';

/** The form fields of the studio and its two side dialogs. */
export interface StudioFieldsState {
  fields: StudioFields;
  setFields: Dispatch<SetStateAction<StudioFields>>;
  /** The prompt picker is open. */
  picking: boolean;
  setPicking(picking: boolean): void;
  /** The save-to-library dialog is open. */
  saving: boolean;
  setSaving(saving: boolean): void;
  /** An entry and model still to be chosen; null for none. */
  pendingModel: PendingModel | null;
  setPendingModel(pending: PendingModel | null): void;
}

/**
 * The form fields of the studio. A studio mounted while the session still keeps the form of its source
 * shows that form (its entry and model chosen once the entry is selected); a fresh opening starts empty.
 *
 * @param fileId the source file
 * @param session the studio session
 * @param choice the image provider choice
 * @returns the fields and their setters
 */
export function useStudioFields(fileId: string, session: StudioSession, choice: ProviderChoice): StudioFieldsState {
  const { providerId, model } = choice;
  // A form the session still keeps for the source is shown again; a fresh opening starts empty.
  const [restored] = useState(() => session.draft(fileId));
  const [fields, setFields] = useState<StudioFields>(() =>
    restored !== undefined ? fieldsOf(restored) : freshFields(readSafeMode()),
  );
  const [picking, setPicking] = useState(false);
  const [saving, setSaving] = useState(false);
  // "Use settings" on another entry: its model is chosen once the entry is selected. A restored form
  // chooses its entry and model the same way.
  const [pendingModel, setPendingModel] = useState<PendingModel | null>(() =>
    restored?.providerId != null ? { providerId: restored.providerId, model: restored.model } : null,
  );
  useEffect(() => {
    if (restored?.providerId != null && restored.providerId !== providerId) choice.setProvider(restored.providerId);
    // Only the first render's entry decides whether the restored one must be selected.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (pendingModel !== null && providerId === pendingModel.providerId) {
    setPendingModel(null);
    if (model !== pendingModel.model) choice.setModel(pendingModel.model);
  }
  return { fields, setFields, picking, setPicking, saving, setSaving, pendingModel, setPendingModel };
}
