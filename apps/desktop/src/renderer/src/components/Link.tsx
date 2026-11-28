import type { ReactNode } from 'react';
import { FOCUS } from '../ui';

/** The props of `Link`. */
interface Props {
  /** Called when the link is followed. */
  onFollow(): void;
  /** The link text. */
  children: ReactNode;
  /** The tooltip. */
  title?: string;
  /** Extra classes. */
  className?: string;
  /** Shown dimmed and not followed (e.g. while an import runs); stays focusable for its tooltip. */
  disabled?: boolean;
}

/**
 * An in-app navigation target: a real link that never navigates the document.
 *
 * @param props the follow callback, the text, the tooltip, extra classes and the disabled flag
 * @returns the link
 */
export function Link({ onFollow, children, title, className = '', disabled = false }: Props) {
  return (
    <a
      href="#"
      title={title}
      aria-disabled={disabled || undefined}
      onClick={(event) => {
        event.preventDefault();
        if (!disabled) onFollow();
      }}
      className={`rounded-sm text-accent aria-disabled:opacity-50 ${disabled ? '' : 'hover:underline'} ${FOCUS} ${className}`}
    >
      {children}
    </a>
  );
}
