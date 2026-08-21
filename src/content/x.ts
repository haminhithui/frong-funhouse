import type { XPostRef } from '../types/content'

/**
 * Verified public X posts, URL-only. Every visible detail — name, handle, text,
 * date, media — is rendered by the official X embed (oEmbed) at load time.
 * Nothing here is staged or rehosted.
 */

/** The three verified community posts shown in Wall of Love (and Featured). */
export const X_POSTS: readonly XPostRef[] = [
  {
    id: '2088370565644259531',
    url: 'https://x.com/TradePools/status/2088370565644259531',
  },
  {
    id: '2088371383562850665',
    url: 'https://x.com/saintniko/status/2088371383562850665',
  },
  {
    id: '2088370792132133293',
    url: 'https://x.com/ianheinischmma/status/2088370792132133293',
  },
]

export const X_POST_IDS: readonly string[] = X_POSTS.map((post) => post.id)
export const X_POST_URLS: readonly string[] = X_POSTS.map((post) => post.url)

/** The single post promoted in the "Featured from X" section. */
export const FEATURED_X_POST: XPostRef = X_POSTS[0]

/** The three verified FRONG-live posts from @frongcommunity shown in the Gallery. */
export const GALLERY_POSTS: readonly XPostRef[] = [
  {
    id: '2088518209813029016',
    url: 'https://x.com/frongcommunity/status/2088518209813029016',
  },
  {
    id: '2087638804718829952',
    url: 'https://x.com/frongcommunity/status/2087638804718829952',
  },
  {
    id: '2087931863234904155',
    url: 'https://x.com/frongcommunity/status/2087931863234904155',
  },
]
