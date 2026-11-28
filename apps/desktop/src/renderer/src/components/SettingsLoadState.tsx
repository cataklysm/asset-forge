import { RefreshCw } from 'lucide-react';
import { RETRY_LABEL } from '../labels';
import { ALERT, ICON_BUTTON } from '../ui';

/** The props of `SettingsLoadState`. */
interface Props {
  /** The last load failed and no load runs. */
  failed: boolean;
  /** Shown when the load failed. */
  failedMessage: string;
  /** Loads again; a failure is shown by `failed`. */
  onRetry(): void;
}

/**
 * A settings section before its list is loaded: the failure with a retry, else three skeleton rows.
 *
 * @param props the state, the failure message and the retry
 */
export function SettingsLoadState({ failed, failedMessage, onRetry }: Props) {
  if (failed) {
    return (
      <div className="flex items-start gap-2">
        <p role="alert" className={`flex-1 ${ALERT}`}>
          {failedMessage}
        </p>
        <button type="button" className={ICON_BUTTON} title={RETRY_LABEL} aria-label={RETRY_LABEL} onClick={onRetry}>
          <RefreshCw size={16} aria-hidden />
        </button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3" aria-busy="true">
      {Array.from({ length: 3 }, (_, i) => (
        <div key={i} data-skeleton="" className="h-9 animate-pulse rounded-control bg-raised" />
      ))}
    </div>
  );
}
