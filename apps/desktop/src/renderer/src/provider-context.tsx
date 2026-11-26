import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ListModelsResult, SetVisionSettings, VisionSettingsView } from '@assetforge/contracts';
import { call } from './api';

export interface ProviderState {
  /** Null until the first answer (or when it failed). */
  settings: VisionSettingsView | null;
  /** Null without a base URL, before the first answer, or when the call itself failed. */
  models: ListModelsResult | null;
  /** True while the settings or the model list load. */
  loading: boolean;
  /** True when the last settings load failed (not the same as "not configured"). */
  settingsFailed: boolean;
  /** Loads the settings again, then the model list; rejects when the settings cannot be read. */
  reload(): Promise<void>;
  /** Asks the provider again (`refresh: true`) instead of the main process cache. */
  refreshModels(): Promise<void>;
  /** Saves, takes the returned view and reloads the model list. */
  save(input: SetVisionSettings): Promise<VisionSettingsView>;
}

const EMPTY: ProviderState = {
  settings: null,
  models: null,
  loading: false,
  settingsFailed: false,
  reload: async () => {},
  refreshModels: async () => {},
  save: () => Promise.reject(new Error('No provider settings')),
};

const ProviderContext = createContext<ProviderState>(EMPTY);

/**
 * The vision provider settings and its model list for the app. Loads the settings once on mount
 * and the model list whenever settings with a base URL arrive. It does not poll.
 */
export function ProviderSettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<VisionSettingsView | null>(null);
  const [models, setModels] = useState<ListModelsResult | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [settingsFailed, setSettingsFailed] = useState(false);
  const [modelsLoading, setModelsLoading] = useState(false);
  const disposed = useRef(false);
  // Only the newest model request may set the list; an older answer arriving later is dropped.
  const modelRequest = useRef(0);

  const loadModels = useCallback(async (view: VisionSettingsView | null, refresh: boolean) => {
    const request = ++modelRequest.current;
    if (view === null || view.baseUrl === null) {
      setModels(null);
      setModelsLoading(false);
      return;
    }
    setModelsLoading(true);
    try {
      const result = await call('settings:listVisionModels', refresh ? { refresh: true } : {});
      if (!disposed.current && request === modelRequest.current) setModels(result);
    } catch (e) {
      // A superseded request fails quietly: the newer one decides what the UI shows.
      if (request !== modelRequest.current) return;
      if (!disposed.current) setModels(null);
      throw e;
    } finally {
      if (!disposed.current && request === modelRequest.current) setModelsLoading(false);
    }
  }, []);

  const settingsRef = useRef<VisionSettingsView | null>(null);
  const take = useCallback((view: VisionSettingsView) => {
    settingsRef.current = view;
    setSettings(view);
  }, []);

  // Only the newest reload may take its answer; an older one arriving later is dropped.
  const reloadRequest = useRef(0);
  const reload = useCallback(async () => {
    const request = ++reloadRequest.current;
    setSettingsLoading(true);
    let view: VisionSettingsView;
    try {
      view = await call('settings:getVision', {});
    } catch (e) {
      if (request !== reloadRequest.current) return;
      if (!disposed.current) setSettingsFailed(true);
      throw e;
    } finally {
      if (!disposed.current && request === reloadRequest.current) setSettingsLoading(false);
    }
    if (disposed.current || request !== reloadRequest.current) return;
    setSettingsFailed(false);
    take(view);
    await loadModels(view, false).catch(() => {});
  }, [loadModels, take]);

  useEffect(() => {
    disposed.current = false;
    // A failed first load leaves `settings` null; the screen offers a retry.
    void reload().catch(() => {});
    return () => {
      disposed.current = true;
    };
  }, [reload]);

  const refreshModels = useCallback(() => loadModels(settingsRef.current, true), [loadModels]);

  const save = useCallback(
    async (input: SetVisionSettings) => {
      const view = await call('settings:setVision', input);
      if (!disposed.current) {
        take(view);
        void loadModels(view, false).catch(() => {});
      }
      return view;
    },
    [loadModels, take],
  );

  const value = useMemo<ProviderState>(
    () => ({ settings, models, loading: settingsLoading || modelsLoading, settingsFailed, reload, refreshModels, save }),
    [settings, models, settingsLoading, modelsLoading, settingsFailed, reload, refreshModels, save],
  );

  return <ProviderContext.Provider value={value}>{children}</ProviderContext.Provider>;
}

/** The provider state of the surrounding `ProviderSettingsProvider`; outside one the empty state. */
export function useProvider(): ProviderState {
  return useContext(ProviderContext);
}
