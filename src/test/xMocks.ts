import { vi } from 'vitest'

export const TEST_OEMBED_HTML =
  '<blockquote class="twitter-tweet"><p lang="en" dir="ltr">A test post</p>&mdash; Pond (@pond) <a href="https://x.com/pond/status/1">August 14, 2026</a></blockquote>'

export interface MockXApiOptions {
  oEmbedHtml?: string | null
}

/** Stubs fetch to return official oEmbed markup (blockquote only). */
export function mockXApi(opts: MockXApiOptions = {}) {
  const { oEmbedHtml = TEST_OEMBED_HTML } = opts
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input)
    if (url.includes('publish.twitter.com/oembed')) {
      if (oEmbedHtml === null) return new Response('', { status: 404 })
      return new Response(JSON.stringify({ html: oEmbedHtml }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('', { status: 404 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** Stubs fetch with a never-resolving promise so X cards stay in the loading state. */
export function mockXApiPending() {
  vi.stubGlobal('fetch', () => new Promise<Response>(() => {}))
}

/** Stubs window.twttr so the widgets script is never injected in tests. */
export function mockTwttr() {
  const load = vi.fn(() => {})
  window.twttr = { widgets: { load } }
  return { load }
}

export function resetXMocks() {
  vi.unstubAllGlobals()
  delete window.twttr
}
