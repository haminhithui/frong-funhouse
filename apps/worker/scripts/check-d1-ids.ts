#!/usr/bin/env node
/**
 * Node-only CLI wrapper for the pre-deploy D1 guard.
 *
 * Reads the CHECKED-IN wrangler.json (only when explicitly invoked — the
 * normal test/typecheck commands never touch this) and fails nonzero while
 * an environment's `database_id` is still a placeholder, so a remote
 * `wrangler d1 migrations apply` / `wrangler deploy` cannot run against an
 * unresolved binding.
 *
 * Usage (from apps/worker):
 *   npm run check:d1                     # checks the staging env (default)
 *   npm run check:d1 -- --env production # checks one named env
 *   npm run check:d1 -- --all            # local (top-level) + every env block
 *
 * This file is dev tooling, NOT Worker runtime code: node:fs is allowed
 * here and only here. All validation logic lives in the pure, Worker-safe
 * src/deployment/validateD1Binding.ts.
 */
import { readFileSync } from 'node:fs'
import {
  LOCAL_ENVIRONMENT_NAME,
  validateD1DatabaseBinding,
  type WranglerConfigLike,
} from '../src/deployment/validateD1Binding.ts'

const WRANGLER_JSON = new URL('../wrangler.json', import.meta.url)
const USAGE = `Usage: npm run check:d1 [-- --env <name> | --all]

Checks the checked-in apps/worker/wrangler.json for literal placeholder or
missing D1 database_id values BEFORE any remote wrangler apply.
Default (no flags): checks the "staging" environment.`

function fail(message: string): never {
  console.error(message)
  process.exit(2)
}

const args = process.argv.slice(2)
let environments: string[] | undefined // undefined = default (staging)
let checkAll = false
for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (arg === '--help' || arg === '-h') {
    console.log(USAGE)
    process.exit(0)
  } else if (arg === '--all') {
    checkAll = true
  } else if (arg === '--env') {
    const value = args[i + 1]
    if (!value || value.startsWith('--')) fail(`missing value after --env\n${USAGE}`)
    environments = [value]
    i++
  } else if (arg.startsWith('--env=')) {
    environments = [arg.slice('--env='.length)]
  } else {
    fail(`unknown argument "${arg}"\n${USAGE}`)
  }
}

let config: WranglerConfigLike
try {
  config = JSON.parse(readFileSync(WRANGLER_JSON, 'utf8')) as WranglerConfigLike
} catch (error) {
  fail(`check-d1-ids: cannot read/parse ${WRANGLER_JSON.pathname}: ${String(error)}`)
}

// --all: local (top-level config) plus every named env block.
if (checkAll) {
  const named = config.env && typeof config.env === 'object' ? Object.keys(config.env) : []
  environments = [LOCAL_ENVIRONMENT_NAME, ...named]
}
if (!environments) environments = ['staging']

console.log(`check-d1-ids: validating ${environments.join(', ')} in wrangler.json`)

let failed = false
for (const environment of environments) {
  const result = validateD1DatabaseBinding(config, environment)
  if (result.ok) {
    console.log(
      `  ok       ${environment}: binding "${result.binding}" database_id ${result.databaseId}`,
    )
    continue
  }
  failed = true
  for (const problem of result.problems) {
    console.error(`  PROBLEM  ${environment} [${problem.code}]: ${problem.message}`)
  }
}

if (failed) {
  console.error(
    'check-d1-ids: FAILED — replace the placeholder database_id value(s) with the real D1 UUID ' +
      '(npx wrangler d1 create <name>) before any remote apply. See ENVIRONMENTS.md §2.',
  )
  process.exit(1)
}
console.log('check-d1-ids: PASS — no placeholder or missing D1 database_id found.')
