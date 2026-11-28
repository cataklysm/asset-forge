import { GenerationParametersSchema, GenerationSchema, type GenerationFile } from '@assetforge/contracts';
import type { GenerationFileRef, GenerationRow } from '@assetforge/core';
import { asc, eq, inArray, type SQL } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { errorCodeOf } from './job-rows.js';
import { file, generation, generationInput, generationOutput, job, promptVersion } from './schema.js';

// The generation records as the repository reads them: one generation with its job status, its prompt and its
// input and output files.

/** A handle that can read: the database or a transaction on it. */
export type GenerationReader = Pick<BetterSQLite3Database, 'select'>;

/** The table of the input files or the one of the output files. */
type GenerationFileTable = typeof generationInput | typeof generationOutput;

/** The values of the `prompt_variables` column. */
const VariablesSchema = GenerationSchema.shape.promptVariables.unwrap();

/**
 * The `prompt_variables` column.
 *
 * @param text the column
 * @returns the values; null when absent or when it does not parse
 */
function parseVariables(text: string | null): Record<string, string> | null {
  if (text === null) return null;
  try {
    const column: unknown = JSON.parse(text);
    if (typeof column !== 'object' || column === null || (column as { v?: unknown }).v !== 1) return null;
    const parsed = VariablesSchema.safeParse((column as { values?: unknown }).values);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * The input or output rows of these generations, with the file's trash state.
 *
 * @param reader the caller's transaction
 * @param table the input or the output table
 * @param ids the generations
 * @returns the files by generation id, in position order
 */
function filesOf(
  reader: GenerationReader,
  table: GenerationFileTable,
  ids: readonly string[],
): Map<string, GenerationFile[]> {
  const result = new Map<string, GenerationFile[]>();
  if (ids.length === 0) return result;
  const rows = reader
    .select({
      generationId: table.generationId,
      fileId: table.fileId,
      name: table.originalName,
      sha256: table.sha256,
      deletedAt: file.deletedAt,
    })
    .from(table)
    .leftJoin(file, eq(file.id, table.fileId))
    .where(inArray(table.generationId, [...ids]))
    .orderBy(asc(table.generationId), asc(table.position))
    .all();
  for (const row of rows) {
    const list = result.get(row.generationId) ?? [];
    list.push({ fileId: row.fileId, name: row.name, sha256: row.sha256, trashed: row.deletedAt !== null });
    result.set(row.generationId, list);
  }
  return result;
}

/**
 * The generations matching `where` in `order` order, with their job status and files.
 *
 * @param reader the caller's transaction
 * @param where the condition
 * @param order the sort order
 * @param limit the most generations to read; undefined for all
 * @returns the generations; throws on unparsable parameters
 */
export function loadGenerations(
  reader: GenerationReader,
  where: SQL | undefined,
  order: SQL[] = [],
  limit?: number,
): GenerationRow[] {
  const query = reader
    .select({ record: generation, jobStatus: job.status, promptId: promptVersion.promptId })
    .from(generation)
    .leftJoin(job, eq(job.id, generation.jobId))
    .leftJoin(promptVersion, eq(promptVersion.id, generation.promptVersionId))
    .where(where)
    .orderBy(...order);
  const rows = limit === undefined ? query.all() : query.limit(limit).all();
  const ids = rows.map((row) => row.record.id);
  const inputs = filesOf(reader, generationInput, ids);
  const outputs = filesOf(reader, generationOutput, ids);
  return rows.map(({ record, jobStatus, promptId }) => ({
    id: record.id,
    kind: record.kind,
    status: record.status,
    errorCode: errorCodeOf(record.errorCode),
    providerId: record.providerId,
    providerName: record.providerName,
    providerKind: record.providerKind,
    model: record.model,
    prompt: record.prompt,
    parameters: GenerationParametersSchema.parse(JSON.parse(record.parameters)),
    jobId: record.jobId,
    jobStatus,
    createdAt: record.createdAt,
    finishedAt: record.finishedAt,
    inputs: inputs.get(record.id) ?? [],
    outputs: outputs.get(record.id) ?? [],
    promptId: record.promptVersionId === null ? null : promptId,
    promptVersionId: record.promptVersionId,
    promptTitle: record.promptTitle,
    promptVersionNumber: record.promptVersionNumber,
    promptVariables: parseVariables(record.promptVariables),
  }));
}

/**
 * The row of one input or output file.
 *
 * @param generationId the generation
 * @param position the place of the file among the generation's inputs or outputs
 * @param ref the file with its checksum and name
 * @returns the values to insert
 */
export function fileRefRow(generationId: string, position: number, ref: GenerationFileRef) {
  return {
    generationId,
    position,
    fileId: ref.fileId,
    sha256: ref.sha256,
    originalName: ref.originalName,
  };
}
