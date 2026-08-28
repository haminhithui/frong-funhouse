import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import GameApp from '../game/GameApp'
import { renderGame } from '../game/render'
import { createGame } from '../game/sim/sim'

function recordingContext() {
  const calls: string[] = []
  const gradient = () => ({ addColorStop: () => calls.push('addColorStop') })
  const context = new Proxy({} as CanvasRenderingContext2D, {
    get(_target, property: string) {
      if (property === 'createLinearGradient' || property === 'createRadialGradient') {
        return (...args: number[]) => {
          void args
          calls.push(property)
          return gradient()
        }
      }
      return (...args: unknown[]) => {
        void args
        calls.push(property)
      }
    },
  })
  return { calls, context }
}

beforeEach(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    writable: true,
    value: () => null,
  })
})

describe('FRONG Catch visual contract', () => {
  it('frames the attract screen as an accessible arcade briefing', () => {
    render(<GameApp durationTicks={600} countdownTicks={1} />)

    expect(screen.getByRole('region', { name: 'FRONG Catch briefing' })).toBeInTheDocument()
    expect(screen.getByText('60 SEC RUN')).toBeInTheDocument()
    expect(screen.getByText('45 TARGETS')).toBeInTheDocument()
    expect(screen.getByText('109 PERFECT')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'FRONG mascot' })).toBeInTheDocument()
  })

  it('exposes tier progress and run status without hiding the HUD from assistive tech', async () => {
    const user = userEvent.setup()
    render(<GameApp durationTicks={600} countdownTicks={1} />)

    await user.click(screen.getByRole('button', { name: 'Play' }))

    expect(screen.getByText('LIVE RUN')).toBeInTheDocument()
    const progress = screen.getByRole('progressbar', { name: /progress to next tier/i })
    expect(progress).toHaveAttribute('aria-valuemin', '0')
    expect(progress).toHaveAttribute('aria-valuemax', '100')
    expect(progress).toHaveAttribute('aria-valuenow')
  })
})

describe('FRONG Catch renderer', () => {
  it('draws layered ambience without mutating deterministic simulation state', () => {
    const state = createGame(0x12345678)
    const before = JSON.stringify(state)
    const { calls, context } = recordingContext()

    renderGame(context, state, { frong: null }, { reducedMotion: false })

    expect(JSON.stringify(state)).toBe(before)
    expect(calls).toContain('createRadialGradient')
    expect(calls.filter((call) => call === 'quadraticCurveTo').length).toBeGreaterThan(0)
    expect(calls.filter((call) => call === 'lineTo').length).toBeGreaterThan(0)
  })
})
