import { useId, type RefObject } from 'react';
import type { FileKind, SiteProfile } from '@assetforge/contracts';
import {
  DELETE_LABEL,
  DELETE_SITE_PROFILE_TITLE,
  FILE_KIND_OPTIONS,
  FILE_XPATH_LABEL,
  FILE_XPATH_TITLE,
  LOG_IN_LABEL,
  LOG_IN_TITLE,
  MAX_FILES_LABEL,
  MAX_FILES_TITLE,
  MAX_PAGES_LABEL,
  MAX_PAGES_TITLE,
  MIN_SIZE_LABEL,
  MIN_SIZE_TITLE,
  NEW_SITE_PROFILE_LABEL,
  NEW_SITE_PROFILE_OPTION,
  NEW_SITE_PROFILE_TITLE,
  PAGINATION_XPATH_LABEL,
  PAGINATION_XPATH_TITLE,
  SAVE_LABEL,
  SAVE_SITE_PROFILE_TITLE,
  SITE_ADDRESS_LABEL,
  SITE_ADDRESS_TITLE,
  SITE_KINDS_LABEL,
  SITE_LABEL,
  SITE_PROFILE_LABEL,
  SITE_PROFILE_NAME_LABEL,
  SITE_PARALLEL_LABEL,
  SITE_PARALLEL_TITLE,
  SITE_GAP_LABEL,
  SITE_GAP_TITLE,
  SITE_TIMEOUT_LABEL,
  SITE_TIMEOUT_TITLE,
  THUMBNAILS_XPATH_LABEL,
  THUMBNAILS_XPATH_TITLE,
  URL_CONTAINS_LABEL,
  URL_CONTAINS_TITLE,
} from '../labels';
import { BUTTON, FOCUS, INPUT, LABEL, SELECT } from '../ui';
import { orderedKinds, type ProfileDraft } from './site-import-state';

// The left half of the site import dialog: the profile select and the form of the selected profile.

/** The props of one labelled text input. */
interface FieldProps {
  /** The visible label. */
  label: string;
  /** The tooltip of the input. */
  title?: string;
  /** The typed text. */
  value: string;
  /** Whether the input takes no typing. */
  readOnly: boolean;
  /** Whether a number is typed, for the on-screen keyboard. */
  numeric?: boolean;
  /** Receives the typed text. */
  onChange(value: string): void;
}

/**
 * A labelled text input of the dialog.
 *
 * @param props the label, tooltip, value and change
 * @returns the label above the input
 */
export function Field({ label, title, value, readOnly, numeric = false, onChange }: FieldProps) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className={LABEL}>
        {label}
      </label>
      <input
        id={id}
        type="text"
        className={INPUT}
        title={title}
        spellCheck={false}
        inputMode={numeric ? 'decimal' : undefined}
        value={value}
        readOnly={readOnly}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

/** The props of the profile form. */
interface Props {
  /** The id of the profile select, for its label. */
  selectId: string;
  /** The profile select, which takes the dialog's first focus. */
  selectRef: RefObject<HTMLSelectElement | null>;
  /** The saved profiles. */
  profiles: readonly SiteProfile[];
  /** The selected profile's id; null for a new one. */
  selectedId: string | null;
  /** The selected saved profile; null for a new one. */
  saved: SiteProfile | null;
  /** The form as typed. */
  draft: ProfileDraft;
  /** Whether a test or a request runs, so that nothing can be changed. */
  locked: boolean;
  /** Whether the form differs from the saved profile. */
  dirty: boolean;
  /** Whether the form holds values the profile takes. */
  savable: boolean;
  /** Selects a saved profile, or null for a new one. */
  onSelect(profile: SiteProfile | null): void;
  /** Changes some fields of the form. */
  onDraftChange(patch: Partial<ProfileDraft>): void;
  /** Saves the form. */
  onSave(): void;
  /** Asks to delete the selected profile. */
  onDelete(): void;
  /** Opens the login window of the selected profile. */
  onLogIn(): void;
}

/**
 * Keeps the profile's actions alongside its picker while the remaining fields scroll.
 * @param props saved profile, validation state and actions
 * @returns the persistent action row
 */
function SiteProfileActions({ locked, dirty, savable, saved, onSave, onDelete, onLogIn }: Props) {
  return (
    <div className="flex flex-wrap gap-2">
      <button
        type="button"
        className={BUTTON}
        title={SAVE_SITE_PROFILE_TITLE}
        disabled={locked || !dirty || !savable}
        onClick={onSave}
      >
        {SAVE_LABEL}
      </button>
      <button
        type="button"
        className={BUTTON}
        title={DELETE_SITE_PROFILE_TITLE}
        disabled={locked || saved === null}
        onClick={onDelete}
      >
        {DELETE_LABEL}
      </button>
      <button
        type="button"
        className={BUTTON}
        title={LOG_IN_TITLE}
        disabled={locked || saved === null}
        onClick={onLogIn}
      >
        {LOG_IN_LABEL}
      </button>
    </div>
  );
}

/**
 * The profile select, the profile's fields and Save, Delete and Log in.
 *
 * @param props the profiles, the form and its actions
 * @returns the form's section
 */
export function SiteProfileForm(props: Props) {
  const { selectId, selectRef, profiles, selectedId, saved, draft, locked, onSelect, onDraftChange } = props;

  /** Adds or removes one kind, keeping the checkbox order. */
  function toggleKind(kind: FileKind, on: boolean) {
    onDraftChange({ kinds: orderedKinds(on ? [...draft.kinds, kind] : draft.kinds.filter((other) => other !== kind)) });
  }

  return (
    <section className="flex flex-col gap-2">
      <div className="sticky top-0 z-10 flex flex-col gap-2 border-b border-line bg-surface pb-3">
        <label htmlFor={selectId} className={LABEL}>
          {SITE_PROFILE_LABEL}
        </label>
        <div className="flex gap-2">
          <select
            id={selectId}
            ref={selectRef}
            className={`${SELECT} min-w-0 flex-1`}
            value={selectedId ?? ''}
            disabled={locked}
            onChange={(event) => onSelect(profiles.find((profile) => profile.id === event.target.value) ?? null)}
          >
            {selectedId === null && <option value="">{NEW_SITE_PROFILE_OPTION}</option>}
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={BUTTON}
            title={NEW_SITE_PROFILE_TITLE}
            disabled={locked}
            onClick={() => onSelect(null)}
          >
            {NEW_SITE_PROFILE_LABEL}
          </button>
        </div>
        <SiteProfileActions {...props} />
      </div>
      <Field
        label={SITE_PROFILE_NAME_LABEL}
        value={draft.name}
        readOnly={locked}
        onChange={(name) => onDraftChange({ name })}
      />
      {saved === null ? (
        <Field
          label={SITE_ADDRESS_LABEL}
          title={SITE_ADDRESS_TITLE}
          value={draft.siteAddress}
          readOnly={locked}
          onChange={(siteAddress) => onDraftChange({ siteAddress })}
        />
      ) : (
        <div className="flex flex-col gap-1">
          <span className={LABEL}>{SITE_LABEL}</span>
          <span className="text-sm text-text">{saved.site}</span>
        </div>
      )}
      <Field
        label={THUMBNAILS_XPATH_LABEL}
        title={THUMBNAILS_XPATH_TITLE}
        value={draft.thumbnails}
        readOnly={locked}
        onChange={(thumbnails) => onDraftChange({ thumbnails })}
      />
      <Field
        label={PAGINATION_XPATH_LABEL}
        title={PAGINATION_XPATH_TITLE}
        value={draft.pagination}
        readOnly={locked}
        onChange={(pagination) => onDraftChange({ pagination })}
      />
      <Field
        label={FILE_XPATH_LABEL}
        title={FILE_XPATH_TITLE}
        value={draft.file}
        readOnly={locked}
        onChange={(file) => onDraftChange({ file })}
      />
      <fieldset className="flex flex-col gap-1">
        <legend className={LABEL}>{SITE_KINDS_LABEL}</legend>
        <div className="flex flex-wrap gap-3">
          {FILE_KIND_OPTIONS.map(({ kind, title }) => (
            <label key={kind} className="inline-flex items-center gap-2 text-sm text-text">
              <input
                type="checkbox"
                className={`accent-accent ${FOCUS}`}
                checked={draft.kinds.includes(kind)}
                disabled={locked}
                onChange={(event) => toggleKind(kind, event.target.checked)}
              />
              {title}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid grid-cols-2 gap-2">
        <Field
          label={MIN_SIZE_LABEL}
          title={MIN_SIZE_TITLE}
          value={draft.minKb}
          readOnly={locked}
          numeric
          onChange={(minKb) => onDraftChange({ minKb })}
        />
        <Field
          label={URL_CONTAINS_LABEL}
          title={URL_CONTAINS_TITLE}
          value={draft.urlContains}
          readOnly={locked}
          onChange={(urlContains) => onDraftChange({ urlContains })}
        />
        <Field
          label={MAX_PAGES_LABEL}
          title={MAX_PAGES_TITLE}
          value={draft.maxPages}
          readOnly={locked}
          numeric
          onChange={(maxPages) => onDraftChange({ maxPages })}
        />
        <Field
          label={MAX_FILES_LABEL}
          title={MAX_FILES_TITLE}
          value={draft.maxFiles}
          readOnly={locked}
          numeric
          onChange={(maxFiles) => onDraftChange({ maxFiles })}
        />
        <Field
          label={SITE_PARALLEL_LABEL}
          title={SITE_PARALLEL_TITLE}
          value={draft.detailConcurrency}
          readOnly={locked}
          numeric
          onChange={(detailConcurrency) => onDraftChange({ detailConcurrency })}
        />
        <Field
          label={SITE_GAP_LABEL}
          title={SITE_GAP_TITLE}
          value={draft.requestGapMs}
          readOnly={locked}
          numeric
          onChange={(requestGapMs) => onDraftChange({ requestGapMs })}
        />
        <Field
          label={SITE_TIMEOUT_LABEL}
          title={SITE_TIMEOUT_TITLE}
          value={draft.pageTimeoutSeconds}
          readOnly={locked}
          numeric
          onChange={(pageTimeoutSeconds) => onDraftChange({ pageTimeoutSeconds })}
        />
      </div>
    </section>
  );
}
