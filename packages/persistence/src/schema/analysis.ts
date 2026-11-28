import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { file } from './files.js';

// The AI analysis of files: the record of the latest analysis and the waiting tag proposal.

/** Provenance of the latest analysis of a file; replaced by the next one. */
export const fileAnalysis = sqliteTable('file_analysis', {
  fileId: text('file_id')
    .primaryKey()
    .references(() => file.id),
  sha256: text('sha256').notNull(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  promptVersion: integer('prompt_version').notNull(),
  /** Name of the analysis prompt used, as it was then; null for rows from before analysis prompts. */
  promptName: text('prompt_name'),
  analysedAt: text('analysed_at').notNull(),
});

/**
 * A tag proposal waiting for the owner; one per file, replaced by the next one. `tags` is a JSON array of
 * `{ name, displayName }`.
 */
export const fileAnalysisProposal = sqliteTable('file_analysis_proposal', {
  fileId: text('file_id')
    .primaryKey()
    .references(() => file.id),
  sha256: text('sha256').notNull(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  promptVersion: integer('prompt_version').notNull(),
  tags: text('tags').notNull(),
  /** Name of the analysis prompt used, as it was then; null for rows from before analysis prompts. */
  promptName: text('prompt_name'),
  createdAt: text('created_at').notNull(),
});
