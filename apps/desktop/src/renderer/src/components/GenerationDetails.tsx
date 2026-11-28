import { Copy } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Generation, GenerationFile } from '@assetforge/contracts';
import { call } from '../api';
import { useJobs } from '../jobs-context';
import {
  COPY_PROMPT_FAILED,
  COPY_PROMPT_TITLE,
  DELETED_MARK,
  GENERATED_FROM_LABEL,
  attachedPromptLabel,
  generationParametersText,
  ATTACHED_PROMPT_LABEL,
  LINKED_FILE_FAILED,
  MODEL_LABEL,
  PARAMETERS_LABEL,
  promptValuesTitle,
  PROMPT_LABEL,
  PROVIDER_LABEL,
  RESULTS_LABEL,
  TRASHED_MARK,
} from '../labels';
import { useStudio } from '../studio-context';
import { ALERT, ICON_BUTTON_INLINE, LABEL, MUTED, PANEL_TITLE } from '../ui';
import { Link } from './Link';

/** The answer of `generations:forFile` for one file. */
interface Lineage {
  fileId: string;
  madeBy: Generation | null;
  results: readonly Generation[];
}

/**
 * The output files of `results`, one entry per output file, newest generation first as answered; an output
 * listed twice shows once.
 *
 * @param results the generations made from the file
 * @returns the distinct output files
 */
function distinctOutputs(results: readonly Generation[]): GenerationFile[] {
  const seen = new Set<string>();
  return results
    .flatMap((generation) => generation.outputs)
    .filter((output) => {
      const key = output.fileId ?? `name:${output.name}:${output.sha256}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/**
 * Writes `text` to the clipboard.
 *
 * @param text the text
 * @returns resolves to true when it was written
 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * The generation that made the file (its sources, provider, model, parameters and prompt) and the
 * files generated from it. A source or result is a link that opens it; once purged only its name
 * stays, with the deleted mark. Reloads whenever jobs change, so a new result shows up.
 *
 * @param props.fileId the file shown in the detail dialog
 */
export function GenerationDetails({ fileId }: { fileId: string }) {
  const { changeToken } = useJobs();
  const [lineage, setLineage] = useState<Lineage | null>(null);
  useEffect(() => {
    let live = true;
    call('generations:forFile', { fileId }).then(
      (answer) => {
        if (live) setLineage({ fileId, madeBy: answer.madeBy, results: answer.results });
      },
      // Without an answer the blocks stay as they were (or absent); the file itself is unaffected.
      () => {},
    );
    return () => {
      live = false;
    };
  }, [fileId, changeToken]);

  if (lineage === null || lineage.fileId !== fileId) return null;
  const { madeBy } = lineage;
  const outputs = distinctOutputs(lineage.results);

  return (
    <>
      {madeBy !== null && <MadeBy generation={madeBy} />}
      {outputs.length > 0 && (
        <section aria-label={RESULTS_LABEL} className="space-y-2">
          <h3 className={PANEL_TITLE}>{RESULTS_LABEL}</h3>
          <FileLinks files={outputs} />
        </section>
      )}
    </>
  );
}

/**
 * The `Generated from` block: the sources, provider, model, parameters, the library prompt and the prompt text.
 *
 * @param props.generation the generation that made the file
 */
function MadeBy({ generation }: { generation: Generation }) {
  const [copyFailed, setCopyFailed] = useState(false);
  const { prompt } = generation;
  return (
    <section aria-label={GENERATED_FROM_LABEL} className="space-y-2">
      <h3 className={PANEL_TITLE}>{GENERATED_FROM_LABEL}</h3>
      <FileLinks files={generation.inputs} />
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-1.5 text-sm">
        <dt className={LABEL}>{PROVIDER_LABEL}</dt>
        <dd className="break-words">{generation.providerName}</dd>
        {generation.model !== null && (
          <>
            <dt className={LABEL}>{MODEL_LABEL}</dt>
            <dd className="break-words">{generation.model}</dd>
          </>
        )}
        <dt className={LABEL}>{PARAMETERS_LABEL}</dt>
        <dd>{generationParametersText(generation.parameters)}</dd>
        <AttachedPrompt generation={generation} />
      </dl>
      {prompt !== null && (
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className={`text-sm ${LABEL}`}>{PROMPT_LABEL}</span>
            <button
              type="button"
              aria-label={COPY_PROMPT_TITLE}
              title={COPY_PROMPT_TITLE}
              className={ICON_BUTTON_INLINE}
              onClick={() => void copyToClipboard(prompt).then((copied) => setCopyFailed(!copied))}
            >
              <Copy size={14} aria-hidden />
            </button>
          </div>
          <p className="whitespace-pre-wrap break-words text-sm">{prompt}</p>
        </div>
      )}
      {copyFailed && (
        <p role="alert" className={ALERT}>
          {COPY_PROMPT_FAILED}
        </p>
      )}
    </section>
  );
}

/**
 * The library prompt row of `MadeBy`: `<title> v<n>`, a link to the Prompts screen while the prompt exists, with
 * the values in the tooltip. Nothing for a generation without a library prompt.
 *
 * @param props.generation the generation that made the file
 */
function AttachedPrompt({ generation }: { generation: Generation }) {
  const studio = useStudio();
  if (generation.promptTitle === null || generation.promptVersionNumber === null) return null;
  return (
    <>
      <dt className={LABEL}>{ATTACHED_PROMPT_LABEL}</dt>
      <dd className="break-words">
        {generation.promptId === null ? (
          <span title={promptValuesTitle(generation.promptVariables)}>
            {attachedPromptLabel(generation.promptTitle, generation.promptVersionNumber)}
          </span>
        ) : (
          <Link
            title={promptValuesTitle(generation.promptVariables)}
            onFollow={() => studio.openPrompt(generation.promptId!)}
          >
            {attachedPromptLabel(generation.promptTitle, generation.promptVersionNumber)}
          </Link>
        )}
      </dd>
    </>
  );
}

/**
 * The files of a generation as links that open them; a purged one shows its name with the deleted mark.
 *
 * @param props.files the inputs or outputs
 */
function FileLinks({ files }: { files: readonly GenerationFile[] }) {
  const studio = useStudio();
  const [failed, setFailed] = useState(false);
  const follow = (fileId: string) => {
    setFailed(false);
    studio.openFile(fileId).catch(() => setFailed(true));
  };
  return (
    <>
      <ul className="space-y-1 text-sm">
        {files.map((file, index) => (
          <li key={file.fileId ?? `purged-${index}`} className="break-words">
            {file.fileId === null ? (
              <>
                <span>{file.name}</span> <span className={MUTED}>{DELETED_MARK}</span>
              </>
            ) : (
              <>
                <Link onFollow={() => follow(file.fileId!)}>{file.name}</Link>
                {file.trashed && <span className={MUTED}> {TRASHED_MARK}</span>}
              </>
            )}
          </li>
        ))}
      </ul>
      {/* A file that cannot be read any more (e.g. purged since the answer) does not open. */}
      {failed && (
        <p role="alert" className={ALERT}>
          {LINKED_FILE_FAILED}
        </p>
      )}
    </>
  );
}
