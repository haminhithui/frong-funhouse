import { afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { FeaturedFromX } from '../components/FeaturedFromX'
import { DEMO_SITE_CONFIG } from '../content/site'
import { mockTwttr, mockXApi, resetXMocks } from './xMocks'

afterEach(() => {
  resetXMocks()
})

describe('FeaturedFromX', () => {
  it('renders the section heading and one embed card', async () => {
    mockTwttr()
    mockXApi()
    render(<FeaturedFromX featured={DEMO_SITE_CONFIG.featured} />)
    expect(screen.getByRole('heading', { name: 'Featured from X' })).toBeInTheDocument()
    expect(await screen.findByText('A test post')).toBeInTheDocument()
    expect(document.querySelectorAll('.twitter-tweet')).toHaveLength(1)
  })
})
