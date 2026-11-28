import { getTableName, sql } from 'drizzle-orm';
import type { AnySQLiteColumn, AnySQLiteTable } from 'drizzle-orm/sqlite-core';

/**
 * `"table"."column"`. Drizzle renders columns unqualified in a single-table select, and an
 * unqualified `"id"` inside a correlated subquery binds to the subquery's own table.
 *
 * @param table the table
 * @param column a column of it
 * @returns the qualified column
 */
export const qualified = (table: AnySQLiteTable, column: AnySQLiteColumn) =>
  sql`${sql.identifier(getTableName(table))}.${sql.identifier(column.name)}`;
