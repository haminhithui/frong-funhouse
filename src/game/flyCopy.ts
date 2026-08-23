import type { FlyTypeId } from './sim/types'

/** Human labels and one-line notes for the fly legend — shared by practice and paid. */
export const FLY_LABELS: Record<FlyTypeId, string> = {
  gnat: 'Gnat',
  midge: 'Midge',
  drifter: 'Drifter',
  firefly: 'Golden Firefly',
  queen: 'Queen Fly',
}

export const FLY_NOTES: Record<FlyTypeId, string> = {
  gnat: 'Straight fall',
  midge: 'Fast, small',
  drifter: 'Drifts wide',
  firefly: 'Fast, glowing',
  queen: 'Erratic jackpot',
}

export const FLY_TYPE_IDS: readonly FlyTypeId[] = ['gnat', 'midge', 'drifter', 'firefly', 'queen']
