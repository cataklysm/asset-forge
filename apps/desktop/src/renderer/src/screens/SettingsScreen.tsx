import { Page } from '../components/Page';
import { PromptSettings } from '../components/PromptSettings';
import { ProviderSettings } from '../components/ProviderSettings';
import { SETTINGS_LABEL } from '../labels';

/** App-level settings: the vision providers and the analysis prompts, the latter in every provider state. */
export function SettingsScreen() {
  return (
    <Page title={SETTINGS_LABEL}>
      <div className="flex min-h-0 flex-1 flex-col gap-10 overflow-auto">
        <ProviderSettings />
        <PromptSettings />
      </div>
    </Page>
  );
}
