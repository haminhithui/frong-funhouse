import type { EcosystemLink } from '../types/content'

/**
 * External discovery links only — neutral, source-checked, no endorsement.
 * Both URLs were verified directly before being added here.
 */
export const ECOSYSTEM_LINKS: readonly EcosystemLink[] = [
  {
    id: 'pools',
    label: 'Explore Pools',
    url: 'https://pools.trade/t/0x6245e67affA44a23077f0Ea7f981a8DC743a0c47',
    description:
      'An external Robinhood Chain launch and trade surface. Its listings, data, chain availability, and terms can change. Verify everything yourself.',
  },
  {
    id: 'uniswap',
    label: 'Open Uniswap',
    url: 'https://app.uniswap.org/',
    description:
      'An external trade, explore, and pool interface. This link does not confirm that a FRONG pool or route is available.',
  },
]

export const ECOSYSTEM_WARNING =
  'External discovery links only. Not sponsorship, endorsement, or financial advice.'
