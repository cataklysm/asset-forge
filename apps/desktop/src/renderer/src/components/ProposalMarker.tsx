import { Sparkles } from 'lucide-react';
import { PROPOSAL_MARKER_LABEL, PROPOSAL_MARKER_TITLE } from '../labels';

// The marker of a file that has a tag proposal waiting.

/**
 * Marks a file with a stored tag proposal: an icon in the AI colour, no chip, so it never reads as a tag.
 *
 * @param props extra classes
 * @returns the marker
 */
export function ProposalMarker({ className = '' }: { className?: string }) {
  return (
    <span
      role="img"
      aria-label={PROPOSAL_MARKER_LABEL}
      title={PROPOSAL_MARKER_TITLE}
      data-proposal-marker=""
      className={`inline-flex shrink-0 text-ai ${className}`}
    >
      <Sparkles size={16} aria-hidden />
    </span>
  );
}
