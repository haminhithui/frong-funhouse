import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CopyButton } from '../components/CopyButton'

describe('CopyButton', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('copies the value and announces feedback', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })

    render(<CopyButton value="0xabc123" />)

    const button = screen.getByRole('button', { name: 'Copy' })
    await user.click(button)

    expect(writeText).toHaveBeenCalledWith('0xabc123')
    expect(await screen.findByRole('status')).toHaveTextContent('Copied to clipboard')
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument()
  })
})
