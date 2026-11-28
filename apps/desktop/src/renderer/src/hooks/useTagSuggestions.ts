import type { TagSuggestion } from '@assetforge/contracts';
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { call } from '../api';
import { latestOnly } from './useLoad';

/** The most suggestions one request asks for. */
const SUGGESTION_LIMIT = 8;
/** No suggestions. */
const NONE: TagSuggestion[] = [];

/** What `useTagSuggestions` hands to the combobox. */
interface TagSuggestions {
  suggestions: TagSuggestion[];
  /** The index of the active suggestion, or -1. */
  active: number;
  setActive: Dispatch<SetStateAction<number>>;
}

/**
 * The tag suggestions for a prefix while the list is open; a later prefix supersedes an earlier request,
 * and a new prefix as well as every new answer drop the active suggestion.
 *
 * @param open whether the suggestion list is open
 * @param prefix the normalised prefix; '' asks for nothing
 * @returns the suggestions and the active index
 */
export function useTagSuggestions(open: boolean, prefix: string): TagSuggestions {
  const [suggestions, setSuggestions] = useState<TagSuggestion[]>(NONE);
  const [active, setActive] = useState(-1);
  const track = useRef<ReturnType<typeof latestOnly<TagSuggestion[]>> | null>(null);
  track.current ??= latestOnly<TagSuggestion[]>();

  useEffect(() => {
    let mounted = true;
    // The suggestions of the previous prefix stay shown until the answer arrives, but none of them may stay
    // active: Enter would commit it instead of the text now typed.
    setActive(-1);
    if (!open || prefix === '') {
      // Supersedes a request still in flight.
      void track.current!(Promise.resolve(NONE));
      setSuggestions(NONE);
      return;
    }
    void track.current!(call('tags:suggest', { prefix, limit: SUGGESTION_LIMIT })).then((result) => {
      if (!mounted || result.stale) return;
      // Suggestions are a convenience: a failed request just shows none.
      setSuggestions(result.value ?? NONE);
      setActive(-1);
    });
    return () => {
      mounted = false;
    };
  }, [open, prefix]);

  return { suggestions, active, setActive };
}
