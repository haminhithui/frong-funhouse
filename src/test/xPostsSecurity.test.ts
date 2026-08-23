import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchOEmbed } from '../lib/xPosts'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('X oEmbed URL boundary', () => {
  it('does not send non-X URLs to the oEmbed endpoint', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    await expect(fetchOEmbed('https://example.com/post/1')).resolves.toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
