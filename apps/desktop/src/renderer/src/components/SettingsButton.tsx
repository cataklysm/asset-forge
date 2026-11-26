import { BUTTON } from '../ui';

/** The Settings button of the analysis and prompt dialogs: disabled with `blocked` as tooltip. */
export function SettingsButton({ blocked, onClick }: { blocked: string | null; onClick(): void }) {
  return (
    <button
      type="button"
      className={BUTTON}
      disabled={blocked !== null}
      title={blocked ?? undefined}
      onClick={onClick}
    >
      Settings
    </button>
  );
}
