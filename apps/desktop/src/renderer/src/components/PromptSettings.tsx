import { RefreshCw } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import {
  ANALYSIS_PROMPT_NAME_MAX,
  ANALYSIS_PROMPT_TEXT_MAX,
  ANALYSIS_TAG_LIMIT_MAX,
  ANALYSIS_TAG_LIMIT_MIN,
  type AnalysisPrompt,
  type AnalysisPromptPurpose,
  type SaveAnalysisPrompt,
} from '@assetforge/contracts';
import { describeError } from '../api';
import { useAnalysisPrompts } from '../analysis-prompts-context';
import {
  DELETE_LABEL,
  ANALYSIS_DELETE_PROMPT_TITLE,
  ENTER_NAME,
  ENTER_TEXT,
  LAST_PROMPT_TITLE,
  ANALYSIS_NEW_PROMPT_LABEL,
  NEW_PROMPT_NAME,
  NEW_PROMPT_TITLE,
  NO_CHANGES,
  PROMPT_NAME_LABEL,
  PROMPT_NAME_TITLE,
  PROMPT_PURPOSE_LABELS,
  PROMPT_PURPOSE_TITLES,
  PROMPT_TAG_LIMIT_LABEL,
  PROMPT_TAG_LIMIT_TITLE,
  ANALYSIS_PROMPT_TEXT_LABEL,
  ANALYSIS_PROMPT_TEXT_TITLE,
  PROMPTS_LOAD_FAILED,
  PROMPTS_TITLE,
  RESET_LABEL,
  RESET_PROMPT_TITLE,
  RETRY_LABEL,
  SAVE_LABEL,
  TAG_LIMIT_INVALID,
  UNSAVED_CHANGES,
  deletePromptTitle,
} from '../labels';
import { ALERT, BUTTON, BUTTON_INLINE, ICON_BUTTON, INPUT, LABEL, PANEL_TITLE, SECTION_TITLE, TEXTAREA } from '../ui';
import { ConfirmDialog } from './ConfirmDialog';

const PURPOSES: readonly AnalysisPromptPurpose[] = ['tagging', 'image_prompt'];

/** The editable fields of one prompt, as typed. `maxTags` is unused for Image to prompt. */
interface Draft {
  name: string;
  text: string;
  maxTags: string;
}

const draftOf = (prompt: AnalysisPrompt): Draft => ({
  name: prompt.name,
  text: prompt.text,
  maxTags: prompt.purpose === 'tagging' ? String(prompt.maxTags) : '',
});

/** The tag limit, or null when it is not a whole number in range. */
function tagLimitOf(text: string): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const value = Number(text.trim());
  return value >= ANALYSIS_TAG_LIMIT_MIN && value <= ANALYSIS_TAG_LIMIT_MAX ? value : null;
}

/** True when saving `draft` would change `prompt` (values compared as they would be sent). */
function changed(prompt: AnalysisPrompt, draft: Draft | undefined): boolean {
  if (draft === undefined) return false;
  if (draft.name.trim() !== prompt.name || draft.text.trim() !== prompt.text) return true;
  return prompt.purpose === 'tagging' && draft.maxTags.trim() !== String(prompt.maxTags);
}

/** Why the draft cannot be saved, or null when it can. */
function invalidReason(prompt: AnalysisPrompt, draft: Draft): string | null {
  if (draft.name.trim() === '') return ENTER_NAME;
  if (draft.text.trim() === '') return ENTER_TEXT;
  if (prompt.purpose === 'tagging' && tagLimitOf(draft.maxTags) === null) return TAG_LIMIT_INVALID;
  return null;
}

/** The first of 'New prompt', 'New prompt 2', … that no prompt of the purpose carries (ignoring case). */
function freeName(prompts: readonly AnalysisPrompt[], purpose: AnalysisPromptPurpose): string {
  const taken = new Set(prompts.filter((p) => p.purpose === purpose).map((p) => p.name.trim().toLowerCase()));
  for (let n = 1; ; n += 1) {
    const name = n === 1 ? NEW_PROMPT_NAME : `${NEW_PROMPT_NAME} ${n}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

/**
 * The Prompts section of the settings: a list per purpose and an in-place editor of the selected
 * prompt. Drafts are kept per prompt while the section is mounted.
 */
export function PromptSettings() {
  const { prompts, loading, failed, reload, save, remove, reset } = useAnalysisPrompts();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const headingId = useId();

  /** Runs one action at a time; a refusal shows its message. */
  async function run(action: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(describeError(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  const dropDraft = (id: string, only?: Draft) =>
    setDrafts((d) => {
      if (!(id in d) || (only !== undefined && d[id] !== only)) return d;
      const rest = { ...d };
      delete rest[id];
      return rest;
    });

  let body;
  if (prompts === null) {
    body =
      failed && !loading ? (
        <div className="flex items-start gap-2">
          <p role="alert" className={`flex-1 ${ALERT}`}>
            {PROMPTS_LOAD_FAILED}
          </p>
          <button
            type="button"
            className={ICON_BUTTON}
            title={RETRY_LABEL}
            aria-label={RETRY_LABEL}
            onClick={() => void reload().catch(() => {})}
          >
            <RefreshCw size={16} aria-hidden />
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-3" aria-busy="true">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} data-skeleton="" className="h-9 animate-pulse rounded-control bg-raised" />
          ))}
        </div>
      );
  } else {
    const list = prompts;
    const selected = list.find((p) => p.id === selectedId) ?? list[0] ?? null;

    const createIn = (purpose: AnalysisPromptPurpose) =>
      run(async () => {
        const first = list.find((p) => p.purpose === purpose);
        if (first === undefined) return;
        const name = freeName(list, purpose);
        const input: SaveAnalysisPrompt =
          first.purpose === 'tagging'
            ? { purpose: 'tagging', name, text: first.text, maxTags: first.maxTags }
            : { purpose: 'image_prompt', name, text: first.text };
        const created = await save(input);
        setSelectedId(created.id);
        // The copied text may be edited; reset brings the built-in content of the purpose.
        await reset(created.id);
      });

    body = (
      <div className="flex flex-col gap-4">
        {error !== null && (
          <p role="alert" className={ALERT}>
            {error}
          </p>
        )}
        <div className="flex items-start gap-6">
          <div className="flex w-64 shrink-0 flex-col gap-5">
            {PURPOSES.map((purpose) => {
              const own = list.filter((p) => p.purpose === purpose);
              const id = `${headingId}-${purpose}`;
              return (
                <div key={purpose} role="group" aria-labelledby={id} className="flex flex-col gap-2">
                  <h4 id={id} className={PANEL_TITLE} title={PROMPT_PURPOSE_TITLES[purpose]}>
                    {PROMPT_PURPOSE_LABELS[purpose]}
                  </h4>
                  <ul className="flex flex-col gap-1">
                    {own.map((prompt) => (
                      <li key={prompt.id} className="flex flex-col">
                        <button
                          type="button"
                          className={BUTTON_INLINE}
                          aria-pressed={prompt.id === selected?.id}
                          onClick={() => setSelectedId(prompt.id)}
                        >
                          <span className="min-w-0 flex-1 truncate text-left">{prompt.name}</span>
                          {changed(prompt, drafts[prompt.id]) && (
                            <span title={UNSAVED_CHANGES} aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-accent" />
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                  <div>
                    <button
                      type="button"
                      className={BUTTON}
                      title={NEW_PROMPT_TITLE}
                      disabled={busy}
                      onClick={() => void createIn(purpose)}
                    >
                      {ANALYSIS_NEW_PROMPT_LABEL}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          {selected !== null && (
            <Editor
              key={selected.id}
              prompt={selected}
              draft={drafts[selected.id] ?? draftOf(selected)}
              dirty={changed(selected, drafts[selected.id])}
              only={list.filter((p) => p.purpose === selected.purpose).length === 1}
              busy={busy}
              onChange={(patch) =>
                setDrafts((d) => ({ ...d, [selected.id]: { ...(d[selected.id] ?? draftOf(selected)), ...patch } }))
              }
              onSave={(draft) =>
                run(async () => {
                  const name = draft.name.trim();
                  const text = draft.text.trim();
                  const input: SaveAnalysisPrompt =
                    selected.purpose === 'tagging'
                      ? { id: selected.id, purpose: 'tagging', name, text, maxTags: tagLimitOf(draft.maxTags)! }
                      : { id: selected.id, purpose: 'image_prompt', name, text };
                  await save(input);
                  // Edits made while the save ran stay as a draft.
                  dropDraft(selected.id, drafts[selected.id]);
                })
              }
              onReset={() =>
                run(async () => {
                  await reset(selected.id);
                  dropDraft(selected.id);
                })
              }
              onDelete={() => setConfirming(true)}
            />
          )}
        </div>
        <ConfirmDialog
          open={confirming && selected !== null}
          title={selected === null ? '' : deletePromptTitle(selected.name)}
          confirmLabel={DELETE_LABEL}
          busy={busy}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            if (selected === null) return;
            const target = selected;
            void run(async () => {
              try {
                await remove(target.id);
              } finally {
                setConfirming(false);
              }
              dropDraft(target.id);
              setSelectedId(list.find((p) => p.purpose === target.purpose && p.id !== target.id)?.id ?? null);
            });
          }}
        />
      </div>
    );
  }

  return (
    <section className="flex max-w-4xl flex-col gap-4">
      <h3 className={SECTION_TITLE}>{PROMPTS_TITLE}</h3>
      {body}
    </section>
  );
}

interface EditorProps {
  prompt: AnalysisPrompt;
  draft: Draft;
  dirty: boolean;
  /** The only prompt of its purpose: it cannot be deleted. */
  only: boolean;
  busy: boolean;
  onChange(patch: Partial<Draft>): void;
  onSave(draft: Draft): void;
  onReset(): void;
  onDelete(): void;
}

function Editor({ prompt, draft, dirty, only, busy, onChange, onSave, onReset, onDelete }: EditorProps) {
  const reason = invalidReason(prompt, draft) ?? (dirty ? null : NO_CHANGES);
  return (
    <form
      className="flex min-w-0 flex-1 flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (reason === null && !busy) onSave(draft);
      }}
    >
      <label className="flex flex-col gap-1" title={PROMPT_NAME_TITLE}>
        <span className={LABEL}>{PROMPT_NAME_LABEL}</span>
        <input
          type="text"
          className={INPUT}
          value={draft.name}
          maxLength={ANALYSIS_PROMPT_NAME_MAX}
          autoComplete="off"
          onChange={(e) => onChange({ name: e.target.value })}
        />
      </label>
      {prompt.purpose === 'tagging' && (
        <label className="flex flex-col gap-1" title={PROMPT_TAG_LIMIT_TITLE}>
          <span className={LABEL}>{PROMPT_TAG_LIMIT_LABEL}</span>
          <input
            type="number"
            className={`w-32 ${INPUT}`}
            min={ANALYSIS_TAG_LIMIT_MIN}
            max={ANALYSIS_TAG_LIMIT_MAX}
            step={1}
            value={draft.maxTags}
            aria-invalid={tagLimitOf(draft.maxTags) === null || undefined}
            onChange={(e) => onChange({ maxTags: e.target.value })}
          />
        </label>
      )}
      <label className="flex flex-col gap-1" title={ANALYSIS_PROMPT_TEXT_TITLE}>
        <span className={LABEL}>{ANALYSIS_PROMPT_TEXT_LABEL}</span>
        <textarea
          className={TEXTAREA}
          value={draft.text}
          maxLength={ANALYSIS_PROMPT_TEXT_MAX}
          rows={8}
          spellCheck={false}
          onChange={(e) => onChange({ text: e.target.value })}
        />
      </label>
      <div className="flex items-center gap-2">
        <button type="submit" className={BUTTON} disabled={busy || reason !== null} title={reason ?? undefined}>
          {SAVE_LABEL}
        </button>
        <button type="button" className={BUTTON} title={RESET_PROMPT_TITLE} disabled={busy} onClick={onReset}>
          {RESET_LABEL}
        </button>
        <button
          type="button"
          className={BUTTON}
          title={only ? LAST_PROMPT_TITLE : ANALYSIS_DELETE_PROMPT_TITLE}
          disabled={busy || only}
          onClick={onDelete}
        >
          {DELETE_LABEL}
        </button>
      </div>
    </form>
  );
}
