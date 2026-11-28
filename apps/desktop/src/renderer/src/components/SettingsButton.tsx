import { SETTINGS_LABEL } from '../labels';
import { BUTTON } from '../ui';

/**
 * The Settings button of the analysis and prompt dialogs: disabled with `blocked` as tooltip.
 *
 * @param props.blocked why the settings cannot open now; null when they can
 * @param props.onClick opens the settings
 */
export function SettingsButton({ blocked, onClick }: { blocked: string | null; onClick(): void }) {
  return (
    <button type="button" className={BUTTON} disabled={blocked !== null} title={blocked ?? undefined} onClick={onClick}>
      {SETTINGS_LABEL}
    </button>
  );
}
