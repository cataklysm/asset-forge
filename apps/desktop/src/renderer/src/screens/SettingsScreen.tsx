import { BackupSettings } from '../components/BackupSettings';
import { Page } from '../components/Page';
import { PromptSettings } from '../components/PromptSettings';
import { ProviderSettings } from '../components/ProviderSettings';
import { SETTINGS_LABEL } from '../labels';

/**
 * The settings: the vision providers and the analysis prompts at app level, the latter in every provider state,
 * and the backup of the open workspace.
 *
 * @returns the screen
 */
export function SettingsScreen() {
  return (
    <Page title={SETTINGS_LABEL}>
      <div className="flex min-h-0 flex-1 flex-col gap-10 overflow-auto">
        <ProviderSettings />
        <PromptSettings />
        <BackupSettings />
      </div>
    </Page>
  );
}
