import type { ArcadeGameDefinition, ArcadeGameId } from './types'

/**
 * The only registry a new arcade game needs to join. Runtime components are
 * loaded on demand so a new game cannot inflate the fan-site entry bundle.
 */
export const ARCADE_GAME_REGISTRY: Record<ArcadeGameId, ArcadeGameDefinition> = {
  'frong-catch': {
    id: 'frong-catch',
    title: 'FRONG Catch',
    description: 'Catch the pond flies in a one-minute skill run.',
    badge: 'Practice + trophy run',
    thumbnailSrc: '/assets/avatar.png',
    status: 'available',
    load: () => import('./FrongCatchShell'),
  },
  'pond-guardian': {
    id: 'pond-guardian',
    title: 'Pond Guardian',
    description: 'Hold the lily pad for 90 seconds against the swamp.',
    badge: 'Free · local game',
    thumbnailSrc: '/assets/games/pond-guardian/hero-3d-v1.webp',
    status: 'available',
    load: () => import('../games/pond-guardian/PondGuardianApp'),
  },
}
