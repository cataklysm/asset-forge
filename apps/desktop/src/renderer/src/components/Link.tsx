import type { ReactNode } from 'react';
import { FOCUS } from '../ui';

interface Props {
  onFollow(): void;
  children: ReactNode;
  title?: string;
  className?: string;
}

/** An in-app navigation target: a real link that never navigates the document. */
export function Link({ onFollow, children, title, className = '' }: Props) {
  return (
    <a
      href="#"
      title={title}
      onClick={(event) => {
        event.preventDefault();
        onFollow();
      }}
      className={`rounded-sm text-accent hover:underline ${FOCUS} ${className}`}
    >
      {children}
    </a>
  );
}
