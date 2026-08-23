import { INPUT_DEADZONE } from './sim/constants'
import type { InputFrame, Vec2 } from './sim/types'

export interface KeyboardState {
  up: boolean
  down: boolean
  left: boolean
  right: boolean
}

export interface PondGuardianInputState {
  keyboard: KeyboardState
  pointerAim: Vec2 | null
  gamepadMove: Vec2
  gamepadAim: Vec2
  touchMove: Vec2
  touchAim: Vec2
  lastAim: Vec2
  attackQueued: boolean
}

export function applyRadialDeadzone(value: Vec2, deadzone = INPUT_DEADZONE): Vec2 {
  const magnitude = Math.hypot(value.x, value.y)
  if (magnitude <= deadzone) return { x: 0, y: 0 }
  const scaled = Math.min(1, (magnitude - deadzone) / (1 - deadzone))
  return {
    x: (value.x / magnitude) * scaled,
    y: (value.y / magnitude) * scaled,
  }
}

export function createInputState(): PondGuardianInputState {
  return {
    keyboard: { up: false, down: false, left: false, right: false },
    pointerAim: null,
    gamepadMove: { x: 0, y: 0 },
    gamepadAim: { x: 0, y: 0 },
    touchMove: { x: 0, y: 0 },
    touchAim: { x: 0, y: 0 },
    lastAim: { x: 1, y: 0 },
    attackQueued: false,
  }
}

export function resetInputState(input: PondGuardianInputState): void {
  input.keyboard.up = false
  input.keyboard.down = false
  input.keyboard.left = false
  input.keyboard.right = false
  input.pointerAim = null
  input.gamepadMove = { x: 0, y: 0 }
  input.gamepadAim = { x: 0, y: 0 }
  input.touchMove = { x: 0, y: 0 }
  input.touchAim = { x: 0, y: 0 }
  input.attackQueued = false
}

function keyboardVector(keys: KeyboardState): Vec2 {
  return {
    x: (keys.right ? 1 : 0) - (keys.left ? 1 : 0),
    y: (keys.down ? 1 : 0) - (keys.up ? 1 : 0),
  }
}

function chooseVector(primary: Vec2, secondary: Vec2, fallback: Vec2): Vec2 {
  const primaryFiltered = applyRadialDeadzone(primary)
  if (Math.hypot(primaryFiltered.x, primaryFiltered.y) > 0) return primaryFiltered
  const secondaryFiltered = applyRadialDeadzone(secondary)
  if (Math.hypot(secondaryFiltered.x, secondaryFiltered.y) > 0) return secondaryFiltered
  return fallback
}

export function consumeInput(input: PondGuardianInputState, playerPosition: Vec2): InputFrame {
  const move = chooseVector(input.touchMove, input.gamepadMove, keyboardVector(input.keyboard))
  let aim = input.lastAim

  if (input.pointerAim !== null) {
    const pointerVector = {
      x: input.pointerAim.x - playerPosition.x,
      y: input.pointerAim.y - playerPosition.y,
    }
    const filteredPointer = applyRadialDeadzone(pointerVector, 0.001)
    if (Math.hypot(filteredPointer.x, filteredPointer.y) > 0) aim = filteredPointer
  } else {
    aim = chooseVector(input.touchAim, input.gamepadAim, input.lastAim)
  }

  if (Math.hypot(aim.x, aim.y) > 0) input.lastAim = aim
  const frame: InputFrame = {
    move,
    aim,
    attackPressed: input.attackQueued,
  }
  input.attackQueued = false
  return frame
}

export function readGamepadInput(gamepad: Gamepad | null): {
  move: Vec2
  aim: Vec2
  attackPressed: boolean
} {
  if (!gamepad) return { move: { x: 0, y: 0 }, aim: { x: 0, y: 0 }, attackPressed: false }
  const move = applyRadialDeadzone({ x: gamepad.axes[0] ?? 0, y: gamepad.axes[1] ?? 0 })
  const aim = applyRadialDeadzone({ x: gamepad.axes[2] ?? 0, y: gamepad.axes[3] ?? 0 })
  const attackPressed = Boolean(gamepad.buttons[0]?.pressed || gamepad.buttons[7]?.pressed)
  return { move, aim, attackPressed }
}
