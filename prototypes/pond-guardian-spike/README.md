# Pond Guardian mechanic spike

## Question

Is twin-stick movement plus directional melee satisfying when the player must intercept enemies and protect a fixed frog objective for 90 seconds?

## Scope

This folder is intentionally isolated from the shipping game module. A spike may use hard-coded values and primitive shapes; it must not be imported by the application.

## Keep / kill criteria

- Keep when an uncoached player understands the objective within 20 seconds and voluntarily starts another run.
- Refactor when one tuning variable is clearly wrong, such as attack reach, movement speed, or enemy density.
- Kill when the core verb only works after explanation or needs progression, content, or art to feel playable.

The production implementation lives in `src/games/pond-guardian/` and is a rewrite rather than a promotion of this spike.
