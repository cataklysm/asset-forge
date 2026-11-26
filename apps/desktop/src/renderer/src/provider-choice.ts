import { useEffect, useRef, useState } from 'react';
import type { ProviderKind } from '@assetforge/contracts';
import { defaultEditModelOf, defaultModelOf, defaultProviderId, useProviders, type ProvidersState } from './provider-context';

export interface ProviderChoice {
  /** The selected entry: the one chosen while it is listed with the dialog's kind, otherwise `defaultProviderId`. */
  providerId: string | null;
  /** The chosen model of the selected entry, otherwise its default for the dialog. */
  model: string | null;
  /** Selects another entry; its default model is then in force. */
  setProvider(id: string | null): void;
  /** Chooses a model of the selected entry. */
  setModel(model: string | null): void;
}

interface Chosen {
  providerId: string | null;
  /** Undefined while no model was chosen for `providerId`. */
  model?: string | null;
}

/**
 * The provider and model of one dialog over the entries of `kind`. `opening` names the current
 * opening (null while closed): a new opening starts from the defaults and asks every entry for its
 * state once the list is there. A chosen entry that leaves the list falls back to `defaultProviderId`.
 */
function useChoice(
  kind: ProviderKind,
  defaultModel: (state: ProvidersState, id: string | null) => string | null,
  opening: string | null,
): ProviderChoice {
  const providers = useProviders();
  const { list, checkAll } = providers;
  const [chosen, setChosen] = useState<Chosen | null>(null);
  const [lastOpening, setLastOpening] = useState(opening);
  if (opening !== lastOpening) {
    setLastOpening(opening);
    setChosen(null);
  }

  const listed =
    chosen !== null &&
    chosen.providerId !== null &&
    (list?.providers.some((p) => p.id === chosen.providerId && p.kind === kind) ?? false);
  const providerId = listed ? chosen.providerId : defaultProviderId(providers, kind);
  const model =
    chosen !== null && chosen.providerId === providerId && chosen.model !== undefined
      ? chosen.model
      : defaultModel(providers, providerId);

  // Every opening asks every entry once, as soon as the list is there.
  const checked = useRef<string | null>(null);
  const hasList = list !== null;
  useEffect(() => {
    if (opening === null) {
      checked.current = null;
      return;
    }
    if (!hasList || checked.current === opening) return;
    checked.current = opening;
    checkAll();
  }, [opening, hasList, checkAll]);

  return {
    providerId,
    model,
    setProvider: (id) => setChosen({ providerId: id }),
    setModel: (next) => setChosen({ providerId, model: next }),
  };
}

/** The `ollama` entry and model of one analysis dialog; the model defaults to the entry's one for `purpose`. */
export function useProviderChoice(purpose: 'tagging' | 'prompt', opening: string | null): ProviderChoice {
  return useChoice('ollama', (state, id) => defaultModelOf(state, id, purpose), opening);
}

/** The `venice` entry and edit model of the studio; the model defaults to `defaultEditModelOf`. */
export function useImageProviderChoice(opening: string | null): ProviderChoice {
  return useChoice('venice', defaultEditModelOf, opening);
}
