import type { ComponentType } from 'react'

export type ArcadeGameId = 'frong-catch' | 'pond-guardian'

export type ArcadeInitialMode = 'attract' | 'practice' | 'paid'

export interface ArcadeGameRuntimeProps {
  initialMode?: ArcadeInitialMode
  onExit: () => void
}

export interface ArcadeGameDefinition {
  id: ArcadeGameId
  title: string
  description: string
  badge: string
  thumbnailSrc: string
  status: 'available' | 'coming-soon'
  load: () => Promise<{ default: ComponentType<ArcadeGameRuntimeProps> }>
}
