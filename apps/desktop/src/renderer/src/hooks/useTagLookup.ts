import type { TagUsage } from '@assetforge/contracts';
import { useEffect, useState, type RefObject } from 'react';
import { call, describeError } from '../api';
import { SEARCH_DEBOUNCE_MS, useDebouncedValue } from './useDebouncedValue';

/** A lookup answer for one normalised name, or the message of a failed lookup. */
export type Lookup = { name: string; usage: TagUsage } | { name: string; failure: string };

/** What `useTargetLookup` hands to the rename form. */
interface TargetLookup {
  /** The last answer; it belongs to the typed name only when its `name` matches. */
  target: Lookup | null;
  /** Drops the answer and looks the same name up again. */
  retryLookup(): void;
}

/**
 * The usage of the tag being renamed, read once on mount; the input text is selected first.
 *
 * @param name the normalised name of the tag
 * @param inputRef the name input of the form
 * @returns the usage, or null while unknown or when the tag no longer exists
 */
export function useSourceUsage(name: string, inputRef: RefObject<HTMLInputElement | null>): TagUsage | null {
  const [source, setSource] = useState<TagUsage | null>(null);
  useEffect(() => {
    inputRef.current?.select();
    let current = true;
    call('tags:usage', { name }).then(
      (usage) => {
        if (current && usage.exists) setSource(usage);
      },
      // The line keeps the display name alone.
      () => {},
    );
    return () => {
      current = false;
    };
    // Once per tag; the form is keyed by the tag name.
  }, []);
  return source;
}

/**
 * The usage of the typed name, looked up once the debounce has run out; a later name drops an earlier answer.
 *
 * @param lookupName the normalised typed name; '' looks nothing up
 * @returns the last answer and the retry
 */
export function useTargetLookup(lookupName: string): TargetLookup {
  const [target, setTarget] = useState<Lookup | null>(null);
  /** Raised to look the same name up again (after a refused rename). */
  const [lookupRun, setLookupRun] = useState(0);
  const debounced = useDebouncedValue(lookupName, SEARCH_DEBOUNCE_MS);

  useEffect(() => {
    // A name still settling is looked up once the debounce has run out.
    if (debounced === '' || debounced !== lookupName) return;
    // Superseded: a later name (or unmounting) drops this answer.
    let current = true;
    call('tags:usage', { name: debounced }).then(
      (usage) => {
        if (current) setTarget({ name: debounced, usage });
      },
      // A failed lookup is no answer: confirm stays disabled until one for the current text succeeds.
      (error: unknown) => {
        if (current) setTarget({ name: debounced, failure: describeError(error) });
      },
    );
    return () => {
      current = false;
    };
  }, [debounced, lookupName, lookupRun]);

  function retryLookup() {
    setTarget(null);
    setLookupRun((run) => run + 1);
  }

  return { target, retryLookup };
}
