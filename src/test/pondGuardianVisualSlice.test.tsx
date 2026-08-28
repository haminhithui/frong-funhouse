import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import PondGuardianApp from '../games/pond-guardian/PondGuardianApp'

beforeEach(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: () => null,
  })
})

describe('Pond Guardian visual slice', () => {
  it('frames the attract screen as a mission briefing with truthful telemetry', () => {
    render(<PondGuardianApp onExit={vi.fn()} />)

    expect(
      screen.getByRole('region', { name: /pond guardian mission briefing/i }),
    ).toBeInTheDocument()
    expect(screen.getByText('MISSION // HOLD THE CENTER')).toBeInTheDocument()
    expect(screen.getByText('90 SEC')).toBeInTheDocument()
    expect(screen.getByText('3 PHASES')).toBeInTheDocument()
    expect(screen.getByText('4 THREATS')).toBeInTheDocument()
  })

  it('exposes live defense health and phase progress to assistive technology', async () => {
    const user = userEvent.setup()
    render(<PondGuardianApp onExit={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: 'Play Pond Guardian' }))

    expect(screen.getByRole('region', { name: /pond guardian live defense/i })).toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: /frog health/i })).toHaveAttribute(
      'aria-valuenow',
      '8',
    )
    expect(screen.getByRole('progressbar', { name: /phase progress/i })).toHaveAttribute(
      'aria-valuenow',
      '0',
    )
  })
})
