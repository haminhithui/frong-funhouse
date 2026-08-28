/**
 * Focused tests for the pre-deploy D1 binding guard
 * (src/deployment/validateD1Binding.ts).
 *
 * The validator is a PURE function: it receives a parsed Wrangler config
 * object and an environment name and returns structured problems. It never
 * reads process.env, node:fs, Node crypto, or Cloudflare APIs, so it is safe
 * to import from Worker runtime code. Every fixture below is synthetic —
 * the UUIDs are well-formed but made up, and the placeholder literals are
 * the exact strings checked into wrangler.json.
 *
 * These tests deliberately do NOT read the checked-in wrangler.json: the
 * repository intentionally ships placeholders, and the normal `npm test`
 * must stay green because of that, not fail because of it. The standalone
 * guard command (npm run check:d1) is the piece that fails while the
 * placeholder is still present.
 *
 * Run focused:
 *
 *   node --experimental-strip-types --test test/d1PreDeployGuard.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_D1_BINDING,
  validateD1DatabaseBinding,
  type WranglerConfigLike,
} from '../src/deployment/validateD1Binding.ts'

// ---- clearly synthetic fixtures ------------------------------------------------

const UUID_A = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' // well-formed, made up
const UUID_B = '01234567-89ab-4cde-8f01-23456789abcd' // well-formed, made up
const PLACEHOLDER_STAGING = 'REPLACE_WITH_D1_DATABASE_ID_STAGING'
const PLACEHOLDER_LOCAL = 'REPLACE_WITH_D1_DATABASE_ID_LOCAL'

/** Fixture config: like the parsed wrangler.json but with env guaranteed present. */
type FixtureConfig = WranglerConfigLike & { env: NonNullable<WranglerConfigLike['env']> }

/** Minimal wrangler.json shape; only the fields the guard inspects. */
function wranglerConfig(overrides: Partial<WranglerConfigLike> = {}): FixtureConfig {
  return {
    name: 'frong-catch-worker-fixture',
    d1_databases: [
      { binding: 'DB', database_name: 'frong-catch-local-fixture', database_id: UUID_A },
    ],
    env: {
      staging: {
        d1_databases: [
          { binding: 'DB', database_name: 'frong-catch-staging-fixture', database_id: UUID_B },
        ],
      },
    },
    ...overrides,
  } as FixtureConfig
}

const codesOf = (res: ReturnType<typeof validateD1DatabaseBinding>): string[] =>
  res.problems.map((p) => p.code)

// ---- happy path ---------------------------------------------------------------

test('guard: a real (well-formed) UUID database_id passes for staging', () => {
  const res = validateD1DatabaseBinding(wranglerConfig(), 'staging')
  assert.deepEqual(codesOf(res), [])
  assert.equal(res.ok, true)
  assert.equal(res.environment, 'staging')
  assert.equal(res.binding, 'DB')
  assert.equal(res.databaseId, UUID_B)
})

test('guard: the top-level config resolves as the local environment and passes with a UUID', () => {
  const res = validateD1DatabaseBinding(wranglerConfig(), 'local')
  assert.ok(res.ok)
  assert.equal(res.databaseId, UUID_A)
})

test('guard: the literal REPLACE_WITH_D1_DATABASE_ID_LOCAL fails for the top-level config', () => {
  const config = wranglerConfig({ d1_databases: [
    { binding: 'DB', database_name: 'frong-catch-local-fixture', database_id: PLACEHOLDER_LOCAL },
  ] })
  const res = validateD1DatabaseBinding(config, 'local')
  assert.equal(res.ok, false)
  assert.deepEqual(codesOf(res), ['placeholder_database_id'])
})

// ---- placeholder / blank / malformed ids --------------------------------------

test('guard: the literal REPLACE_WITH_D1_DATABASE_ID_STAGING fails as a placeholder', () => {
  const config = wranglerConfig()
  config.env.staging.d1_databases = [
    { binding: 'DB', database_name: 'frong-catch-staging-fixture', database_id: PLACEHOLDER_STAGING },
  ]
  const res = validateD1DatabaseBinding(config, 'staging')
  assert.equal(res.ok, false)
  assert.deepEqual(codesOf(res), ['placeholder_database_id'])
  assert.match(res.problems[0].message, /REPLACE_WITH_D1_DATABASE_ID_STAGING/)
  assert.equal(res.databaseId, undefined)
})

test('guard: a blank/whitespace database_id fails closed', () => {
  const config = wranglerConfig()
  config.env.staging.d1_databases = [
    { binding: 'DB', database_name: 'frong-catch-staging-fixture', database_id: '   ' },
  ]
  const res = validateD1DatabaseBinding(config, 'staging')
  assert.equal(res.ok, false)
  assert.deepEqual(codesOf(res), ['missing_database_id'])
})

test('guard: a missing database_id key fails closed', () => {
  const config = wranglerConfig()
  config.env.staging.d1_databases = [{ binding: 'DB', database_name: 'frong-catch-staging-fixture' }]
  const res = validateD1DatabaseBinding(config, 'staging')
  assert.equal(res.ok, false)
  assert.deepEqual(codesOf(res), ['missing_database_id'])
})

test('guard: a non-UUID database_id fails closed as invalid', () => {
  const config = wranglerConfig()
  config.env.staging.d1_databases = [
    { binding: 'DB', database_name: 'frong-catch-staging-fixture', database_id: 'not-a-uuid' },
  ]
  const res = validateD1DatabaseBinding(config, 'staging')
  assert.equal(res.ok, false)
  assert.deepEqual(codesOf(res), ['invalid_database_id'])
})

test('guard: a template-style placeholder also fails as a placeholder', () => {
  const config = wranglerConfig()
  config.env.staging.d1_databases = [
    { binding: 'DB', database_name: 'frong-catch-staging-fixture', database_id: '<D1_ID_HERE>' },
  ]
  const res = validateD1DatabaseBinding(config, 'staging')
  assert.equal(res.ok, false)
  assert.deepEqual(codesOf(res), ['placeholder_database_id'])
})

// ---- fail-closed structural cases ----------------------------------------------

test('guard: an unknown environment name fails closed', () => {
  const res = validateD1DatabaseBinding(wranglerConfig(), 'staging-eu-central')
  assert.equal(res.ok, false)
  assert.deepEqual(codesOf(res), ['unknown_environment'])
  assert.match(res.problems[0].message, /staging-eu-central/)
})

test('guard: an environment block without the expected DB binding fails closed', () => {
  const config = wranglerConfig()
  config.env.staging.d1_databases = [
    { binding: 'OTHER', database_name: 'x', database_id: UUID_B },
  ]
  const res = validateD1DatabaseBinding(config, 'staging')
  assert.equal(res.ok, false)
  assert.deepEqual(codesOf(res), ['unknown_binding'])
})

test('guard: a missing d1_databases array fails closed', () => {
  const config = wranglerConfig()
  config.env.staging.d1_databases = undefined
  const res = validateD1DatabaseBinding(config, 'staging')
  assert.equal(res.ok, false)
  assert.deepEqual(codesOf(res), ['missing_d1_databases'])
})

test('guard: a non-object config fails closed instead of throwing', () => {
  const res = validateD1DatabaseBinding(null, 'staging')
  assert.equal(res.ok, false)
  assert.deepEqual(codesOf(res), ['invalid_config'])
})

// ---- options -------------------------------------------------------------------

test('guard: a custom expected binding name is honored', () => {
  const config = wranglerConfig()
  config.env.staging.d1_databases = [
    { binding: 'GAME_DB', database_name: 'frong-catch-staging-fixture', database_id: UUID_B },
  ]
  assert.equal(validateD1DatabaseBinding(config, 'staging').ok, false)
  const res = validateD1DatabaseBinding(config, 'staging', { binding: 'GAME_DB' })
  assert.equal(res.ok, true)
  assert.equal(res.binding, 'GAME_DB')
})

test('guard: DEFAULT_D1_BINDING is the wrangler.json binding name "DB"', () => {
  assert.equal(DEFAULT_D1_BINDING, 'DB')
})
