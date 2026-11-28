import type { RelationKind } from '@assetforge/contracts';

/** A relation as the asset that holds it reads it. */
const OUTGOING: Record<RelationKind, string> = {
  uses: 'Uses',
  variant_of: 'Variant of',
  part_of: 'Part of',
  derived_from: 'Derived from',
};

/** A relation as its target asset reads it. */
const INCOMING: Record<RelationKind, string> = {
  uses: 'Used by',
  variant_of: 'Has variant',
  part_of: 'Has part',
  derived_from: 'Source of',
};

/**
 * The label of an asset relation, seen from one of its two ends.
 *
 * @param kind the relation kind
 * @param direction `outgoing` for the asset that holds the relation, `incoming` for its target
 * @returns the label, such as 'Uses' or 'Used by'
 */
export function relationLabel(kind: RelationKind, direction: 'outgoing' | 'incoming'): string {
  return (direction === 'outgoing' ? OUTGOING : INCOMING)[kind];
}
