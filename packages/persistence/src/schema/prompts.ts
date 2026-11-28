import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { tag } from './tags.js';

/** A prompt of the library. `title_key` is the lower-cased title and keeps titles unique regardless of case. */
export const prompt = sqliteTable(
  'prompt',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    titleKey: text('title_key').notNull(),
    description: text('description').notNull().default(''),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [uniqueIndex('prompt_title_key_unique').on(t.titleKey)],
);

/**
 * A version of a prompt; rows are never updated. The current version is the one with the highest number.
 * `variables` is JSON `{ "v": 1, "items": [{ name, defaultValue }] }`.
 */
export const promptVersion = sqliteTable(
  'prompt_version',
  {
    id: text('id').primaryKey(),
    promptId: text('prompt_id')
      .notNull()
      .references(() => prompt.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    content: text('content').notNull(),
    variables: text('variables').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [uniqueIndex('prompt_version_prompt_id_number_unique').on(t.promptId, t.number)],
);

/** Tags of a prompt; always manual, so there is no origin column. */
export const promptTag = sqliteTable(
  'prompt_tag',
  {
    promptId: text('prompt_id')
      .notNull()
      .references(() => prompt.id, { onDelete: 'cascade' }),
    tagId: text('tag_id')
      .notNull()
      .references(() => tag.id),
    createdAt: text('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.promptId, t.tagId] }), index('prompt_tag_tag_id_idx').on(t.tagId)],
);
