/**
 * One flavor line per score tier — the win/lose voice of the results screen.
 * Keyed by tier name (stable strings from sim/constants) so both the practice
 * and paid apps share the same voice.
 */
export const TIER_FLAVOR: Record<string, string> = {
  Tadpole: 'Everyone starts somewhere.',
  'Pond Hopper': 'Getting your hops in.',
  'Fly Snatcher': 'Sharp tongue.',
  'Lily Legend': 'Pond royalty.',
  'Just FRONG.': 'Not Wrong.',
  'Not Wrong.': 'Perfect. Just perfect.',
}
