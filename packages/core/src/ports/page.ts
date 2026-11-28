/** One page of an offset-paged list query. */
export interface Page {
  /** The most items to answer. */
  limit: number;
  /** How many items of the whole result to skip. */
  offset: number;
}
