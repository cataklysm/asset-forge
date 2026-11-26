import type { ReactNode } from 'react';
import { FOCUS } from '../ui';

interface Props {
  onFollow(): void;
  children: ReactNode;
  title?: string;
  className?: string;
  /** Shown dimmed and not followed (e.g. while an import runs); stays focusable for its tooltip. */
  disabled?: boolean;
}

/** An in-app navigation target: a real link that never navigates the document. */
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
