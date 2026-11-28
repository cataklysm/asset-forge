import { useId, useState } from 'react';
import type { AnalysisPrompt, AnalysisPromptPurpose, SaveAnalysisPrompt } from '@assetforge/contracts';
import { describeError } from '../api';
import { useAnalysisPrompts } from '../analysis-prompts-context';
import {
  changed,
  copyInputOf,
  draftOf,
  freeName,
  saveInputOf,
  withoutDraft,
  type AnalysisPromptDraft,
} from '../analysis-prompt-draft';
import { useExclusiveRun } from '../hooks/useExclusiveRun';
import {
  ANALYSIS_NEW_PROMPT_LABEL,
  DELETE_LABEL,
  NEW_PROMPT_TITLE,
  PROMPT_PURPOSE_LABELS,
  PROMPT_PURPOSE_TITLES,
  PROMPTS_LOAD_FAILED,
  PROMPTS_TITLE,
  UNSAVED_CHANGES,
  deletePromptTitle,
} from '../labels';
import { ALERT, BUTTON, BUTTON_INLINE, PANEL_TITLE, SECTION_TITLE } from '../ui';
import { AnalysisPromptEditor } from './AnalysisPromptEditor';
import { ConfirmDialog } from './ConfirmDialog';
import { SettingsLoadState } from './SettingsLoadState';

/** The purposes, in the order the section lists them. */
const PURPOSES: readonly AnalysisPromptPurpose[] = ['tagging', 'image_prompt'];

/** The save and reset of the analysis prompts context. */
interface PromptWrites {
  save(input: SaveAnalysisPrompt): Promise<AnalysisPrompt>;
  reset(id: string): Promise<AnalysisPrompt>;
}

/**
 * Creates a copy of the first prompt of `purpose` under a free name, selects it and resets it to the
 * built-in content of the purpose.
 *
 * @param writes the save and reset
 * @param list the prompts
 * @param purpose the purpose
 * @param select selects a prompt
 * @returns resolves once done; rejects with the refusal
 */
async function createPrompt(
  writes: PromptWrites,
  list: readonly AnalysisPrompt[],
  purpose: AnalysisPromptPurpose,
  select: (id: string) => void,
): Promise<void> {
  const first = list.find((prompt) => prompt.purpose === purpose);
  if (first === undefined) return;
  const created = await writes.save(copyInputOf(first, freeName(list, purpose)));
  select(created.id);
  // The copied text may be edited; reset brings the built-in content of the purpose.
  await writes.reset(created.id);
}

/**
 * Deletes a prompt; the confirmation closes either way, then its draft goes and the next one of the
 * purpose is selected.
 *
 * @param remove the delete of the context
 * @param target the prompt
 * @param closeConfirm closes the confirmation
 * @param after drops the draft and selects the next prompt
 * @returns resolves once deleted; rejects with the refusal
 */
async function deletePrompt(
  remove: (id: string) => Promise<void>,
  target: AnalysisPrompt,
  closeConfirm: () => void,
  after: () => void,
): Promise<void> {
  try {
    await remove(target.id);
  } finally {
    closeConfirm();
  }
  after();
}

/** The props of `PurposeGroup`. */
interface PurposeGroupProps {
  purpose: AnalysisPromptPurpose;
  /** The id of the group heading. */
  headingId: string;
  /** The prompts of the purpose. */
  own: readonly AnalysisPrompt[];
  selectedId: string | undefined;
  drafts: Record<string, AnalysisPromptDraft>;
  busy: boolean;
  select(id: string): void;
  onCreate(): void;
}

/**
 * The prompts of one purpose, each marked when it has unsaved changes, and the action that adds one.
 *
 * @param props the purpose, its prompts, the selection and the handlers
 */
function PurposeGroup({ purpose, headingId, own, selectedId, drafts, busy, select, onCreate }: PurposeGroupProps) {
  return (
    <div role="group" aria-labelledby={headingId} className="flex flex-col gap-2">
      <h4 id={headingId} className={PANEL_TITLE} title={PROMPT_PURPOSE_TITLES[purpose]}>
        {PROMPT_PURPOSE_LABELS[purpose]}
      </h4>
      <ul className="flex flex-col gap-1">
        {own.map((prompt) => (
          <li key={prompt.id} className="flex flex-col">
            <button
              type="button"
              className={BUTTON_INLINE}
              aria-pressed={prompt.id === selectedId}
              onClick={() => select(prompt.id)}
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
        <button type="button" className={BUTTON} title={NEW_PROMPT_TITLE} disabled={busy} onClick={onCreate}>
          {ANALYSIS_NEW_PROMPT_LABEL}
        </button>
      </div>
    </div>
  );
}

/**
 * The Prompts section of the settings: a list per purpose and an in-place editor of the selected
 * prompt. Drafts are kept per prompt while the section is mounted.
 */
export function PromptSettings() {
  const { prompts, loading, failed, reload, save, remove, reset } = useAnalysisPrompts();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, AnalysisPromptDraft>>({});
  const [confirming, setConfirming] = useState(false);
  const { busy, error, run } = useExclusiveRun(describeError);
  const headingId = useId();

  /**
   * Drops the draft of `id`; with `only` given, only while that very draft is kept.
   *
   * @param id the prompt
   * @param only the draft that may be dropped
   */
  const dropDraft = (id: string, only?: AnalysisPromptDraft) => setDrafts((current) => withoutDraft(current, id, only));

  if (prompts === null) {
    return (
      <section className="flex max-w-4xl flex-col gap-4">
        <h3 className={SECTION_TITLE}>{PROMPTS_TITLE}</h3>
        <SettingsLoadState
          failed={failed && !loading}
          failedMessage={PROMPTS_LOAD_FAILED}
          onRetry={() => void reload().catch(() => {})}
        />
      </section>
    );
  }

  const list = prompts;
  const selected = list.find((prompt) => prompt.id === selectedId) ?? list[0] ?? null;

  /**
   * Saves the draft of the selected prompt; edits made while the save ran stay as a draft.
   *
   * @param prompt the selected prompt
   * @param draft the draft as sent
   */
  const savePrompt = (prompt: AnalysisPrompt, draft: AnalysisPromptDraft) => {
    const kept = drafts[prompt.id];
    return run(() => save(saveInputOf(prompt, draft)).then(() => dropDraft(prompt.id, kept)));
  };

  /**
   * Deletes the selected prompt after the confirmation.
   *
   * @param target the prompt the confirmation was shown for
   */
  const confirmDelete = (target: AnalysisPrompt) => {
    const next = list.find((prompt) => prompt.purpose === target.purpose && prompt.id !== target.id)?.id ?? null;
    void run(() =>
      deletePrompt(
        remove,
        target,
        () => setConfirming(false),
        () => {
          dropDraft(target.id);
          setSelectedId(next);
        },
      ),
    );
  };

  return (
    <section className="flex max-w-4xl flex-col gap-4">
      <h3 className={SECTION_TITLE}>{PROMPTS_TITLE}</h3>
      <div className="flex flex-col gap-4">
        {error !== null && (
          <p role="alert" className={ALERT}>
            {error}
          </p>
        )}
        <div className="flex items-start gap-6">
          <div className="flex w-64 shrink-0 flex-col gap-5">
            {PURPOSES.map((purpose) => (
              <PurposeGroup
                key={purpose}
                purpose={purpose}
                headingId={`${headingId}-${purpose}`}
                own={list.filter((prompt) => prompt.purpose === purpose)}
                selectedId={selected?.id}
                drafts={drafts}
                busy={busy}
                select={setSelectedId}
                onCreate={() => void run(() => createPrompt({ save, reset }, list, purpose, setSelectedId))}
              />
            ))}
          </div>
          {selected !== null && (
            <AnalysisPromptEditor
              key={selected.id}
              prompt={selected}
              draft={drafts[selected.id] ?? draftOf(selected)}
              dirty={changed(selected, drafts[selected.id])}
              only={list.filter((prompt) => prompt.purpose === selected.purpose).length === 1}
              busy={busy}
              onChange={(patch) =>
                setDrafts((current) => ({
                  ...current,
                  [selected.id]: { ...(current[selected.id] ?? draftOf(selected)), ...patch },
                }))
              }
              onSave={(draft) => savePrompt(selected, draft)}
              onReset={() => run(() => reset(selected.id).then(() => dropDraft(selected.id)))}
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
            if (selected !== null) confirmDelete(selected);
          }}
        />
      </div>
    </section>
  );
}
