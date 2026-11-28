import { check, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { file } from './files.js';
import { promptVersion } from './prompts.js';
import { GENERATION_KINDS, GENERATION_STATUSES, PROVIDER_KINDS, oneOf } from './vocabulary.js';

/**
 * An image generation (edit or upscale). `parameters` is JSON (`GenerationParametersSchema`). `job_id` names the
 * current job and has no foreign key: the job row may be cleared, or deleted with a purged file, while the generation stays.
 */
export const generation = sqliteTable(
  'generation',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: GENERATION_KINDS }).notNull(),
    status: text('status', { enum: GENERATION_STATUSES }).notNull(),
    errorCode: text('error_code'),
    providerId: text('provider_id').notNull(),
    /** A copy of the provider name taken at start. */
    providerName: text('provider_name').notNull(),
    providerKind: text('provider_kind', { enum: PROVIDER_KINDS }).notNull(),
    model: text('model'),
    prompt: text('prompt'),
    parameters: text('parameters').notNull(),
    jobId: text('job_id'),
    createdAt: text('created_at').notNull(),
    finishedAt: text('finished_at'),
    // The library prompt it was started from (migration 0014); all four null for an upscale or a free prompt.
    // Title and number are copies taken at start, so they outlive the prompt; the version id is set null with it.
    promptVersionId: text('prompt_version_id').references(() => promptVersion.id, { onDelete: 'set null' }),
    promptTitle: text('prompt_title'),
    promptVersionNumber: integer('prompt_version_number'),
    /** JSON `{ "v": 1, "values": { <name>: <value> } }`. */
    promptVariables: text('prompt_variables'),
  },
  (t) => [
    index('generation_job_id_idx').on(t.jobId),
    index('generation_created_at_idx').on(t.createdAt, t.id),
    check('generation_kind_check', oneOf(t.kind, GENERATION_KINDS)),
    check('generation_status_check', oneOf(t.status, GENERATION_STATUSES)),
    check('generation_provider_kind_check', oneOf(t.providerKind, PROVIDER_KINDS)),
  ],
);

/** A file a generation read or wrote, as it was then; a purge sets `file_id` null and keeps checksum and name. */
const generationFile = (name: 'generation_input' | 'generation_output') =>
  sqliteTable(
    name,
    {
      generationId: text('generation_id')
        .notNull()
        .references(() => generation.id, { onDelete: 'cascade' }),
      position: integer('position').notNull(),
      fileId: text('file_id').references(() => file.id, { onDelete: 'set null' }),
      sha256: text('sha256').notNull(),
      originalName: text('original_name').notNull(),
    },
    (t) => [primaryKey({ columns: [t.generationId, t.position] }), index(`${name}_file_id_idx`).on(t.fileId)],
  );

export const generationInput = generationFile('generation_input');
export const generationOutput = generationFile('generation_output');
