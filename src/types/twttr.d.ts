export interface TwttrWidgets {
  /** Transforms .twitter-tweet blockquotes (optionally within `element`) into official embeds. */
  load: (element?: HTMLElement) => void
  createTweet?: (id: string, element: HTMLElement, options?: unknown) => Promise<HTMLElement>
}

export interface Twttr {
  widgets?: TwttrWidgets
}

declare global {
  interface Window {
    twttr?: Twttr
  }
}
