/**
 * Pre-deploy guard for D1 bindings: pure validation of a parsed Wrangler
 * config so a remote `wrangler d1 migrations apply` / `wrangler deploy`
 * can never accidentally run against an unresolved `database_id`.
 *
 * Contract:
 * - PURE and dependency-free. Takes a Wrangler config object (the parsed
 *   wrangler.json) plus an environment name; returns structured problems.
 *   No process.env, node:fs, Node crypto, or Cloudflare APIs — safe to
 *   import from Worker runtime code.
 * - FAIL-CLOSED. Unknown environment, missing d1_databases, a missing
 *   expected binding, a missing/blank database_id, a literal placeholder,
 *   or a non-UUID id all produce problems and ok === false.
 * - Environment resolution mirrors wrangler.json: named environments live
 *   under `env.<name>`; the top-level config is the local/default
 *   environment, selected with the reserved name `local`.
 *
 * This module never reads files and never mutates its input; the Node-only
 * CLI wrapper that loads wrangler.json lives in scripts/check-d1-ids.ts.
 */

/** Shape of the fields this guard inspects (everything else is ignored). */
export interface WranglerD1DatabaseEntryLike {
  binding?: unknown
  database_name?: unknown
  database_id?: unknown
}

export interface WranglerEnvironmentLike {
  d1_databases?: WranglerD1DatabaseEntryLike[]
}

export interface WranglerConfigLike {
  name?: string
  d1_databases?: WranglerD1DatabaseEntryLike[]
  env?: Record<string, WranglerEnvironmentLike>
}

/** Environment name that selects the top-level (local/default) config. */
export const LOCAL_ENVIRONMENT_NAME = 'local'

/** The binding name declared in wrangler.json (`env.DB` in Worker code). */
export const DEFAULT_D1_BINDING = 'DB'

/** Machine-readable problem kinds; messages stay human-readable. */
export type D1BindingProblemCode =
  | 'invalid_config'
  | 'unknown_environment'
  | 'missing_d1_databases'
  | 'unknown_binding'
  | 'missing_database_id'
  | 'placeholder_database_id'
  | 'invalid_database_id'

export interface D1BindingProblem {
  code: D1BindingProblemCode
  /** Environment the problem was found in. */
  environment: string
  /** Binding the problem is attributed to ('' when structurally unknown). */
  binding: string
  message: string
}

export interface D1BindingValidationResult {
  /** True only when zero problems were found. */
  ok: boolean
  environment: string
  /** Resolved expected binding name. */
  binding: string
  /** The validated database_id, set only when ok === true. */
  databaseId?: string
  problems: D1BindingProblem[]
}

export interface ValidateD1BindingOptions {
  /** Expected binding name; defaults to DEFAULT_D1_BINDING ('DB'). */
  binding?: string
}

/** A canonical UUID (8-4-4-4-12 hex); D1 database ids are UUIDs. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Literal placeholder markers this guard rejects. The repo's own literals
 * are REPLACE_WITH_D1_DATABASE_ID_{LOCAL,STAGING,PRODUCTION}; the extra
 * shapes (<...>, ${...}, TODO) catch the common copy-paste variants.
 */
function isPlaceholderId(raw: string): boolean {
  const id = raw.trim()
  if (id.length === 0) return false // blank is reported as missing, not placeholder
  if (/replace_with/i.test(id)) return true
  if (/^\$\{.*\}$/.test(id)) return true
  if (/^<.*>$/.test(id)) return true
  if (/^(?:todo|tbd|fixme|changeme|placeholder)$/i.test(id)) return true
  return false
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Validate the D1 binding for one environment of a Wrangler config.
 *
 * @param config parsed wrangler.json object (or anything; non-objects fail closed)
 * @param environment environment name: 'local' for the top-level config, otherwise a key under `env`
 * @param options optional expected binding name override
 */
export function validateD1DatabaseBinding(
  config: unknown,
  environment: string,
  options: ValidateD1BindingOptions = {},
): D1BindingValidationResult {
  const expectedBinding = options.binding ?? DEFAULT_D1_BINDING
  const problems: D1BindingProblem[] = []
  const problem = (code: D1BindingProblemCode, message: string, binding = ''): void => {
    problems.push({ code, environment, binding, message })
  }

  if (typeof environment !== 'string' || environment.trim() === '') {
    problem('unknown_environment', `environment name is missing or blank`)
    return { ok: false, environment: String(environment), binding: expectedBinding, problems }
  }

  if (!isRecord(config)) {
    problem('invalid_config', `wrangler config is not an object (got ${typeof config})`)
    return { ok: false, environment, binding: expectedBinding, problems }
  }

  // Resolve the environment block: 'local' → top-level config, else env.<name>.
  let envBlock: unknown
  if (environment === LOCAL_ENVIRONMENT_NAME) {
    envBlock = config
  } else if (isRecord(config.env) && environment in config.env) {
    envBlock = (config.env as Record<string, unknown>)[environment]
  } else {
    const known = isRecord(config.env) ? Object.keys(config.env).join(', ') || '(none)' : '(none)'
    problem(
      'unknown_environment',
      `unknown environment "${environment}"; wrangler.json declares: local (top-level), ${known}`,
    )
    return { ok: false, environment, binding: expectedBinding, problems }
  }
  if (!isRecord(envBlock)) {
    problem('invalid_config', `environment "${environment}" is not an object`)
    return { ok: false, environment, binding: expectedBinding, problems }
  }

  const entries = envBlock.d1_databases
  if (!Array.isArray(entries) || entries.length === 0) {
    problem(
      'missing_d1_databases',
      `environment "${environment}" declares no d1_databases; expected binding "${expectedBinding}"`,
      expectedBinding,
    )
    return { ok: false, environment, binding: expectedBinding, problems }
  }

  // Find the expected binding (first match wins, like wrangler name resolution).
  const match = entries.find(
    (entry): entry is WranglerD1DatabaseEntryLike =>
      isRecord(entry) && typeof entry.binding === 'string' && entry.binding === expectedBinding,
  )
  if (!match) {
    const declared = entries
      .map((entry) => (isRecord(entry) && typeof entry.binding === 'string' ? entry.binding : '?'))
      .join(', ')
    problem(
      'unknown_binding',
      `environment "${environment}" has no d1_databases binding "${expectedBinding}" (declared: ${declared || 'none with a binding name'})`,
      expectedBinding,
    )
    return { ok: false, environment, binding: expectedBinding, problems }
  }

  const rawId = match.database_id
  const id = typeof rawId === 'string' ? rawId.trim() : ''

  if (id === '') {
    problem(
      'missing_database_id',
      `environment "${environment}" binding "${expectedBinding}" has a missing or blank database_id`,
      expectedBinding,
    )
  } else if (isPlaceholderId(id)) {
    problem(
      'placeholder_database_id',
      `environment "${environment}" binding "${expectedBinding}" still has the placeholder database_id "${id}" — run \`npx wrangler d1 create\` and paste the real UUID into wrangler.json before any remote apply`,
      expectedBinding,
    )
  } else if (!UUID_PATTERN.test(id)) {
    problem(
      'invalid_database_id',
      `environment "${environment}" binding "${expectedBinding}" database_id "${id}" is not a UUID (D1 database ids are UUIDs)`,
      expectedBinding,
    )
  }

  const ok = problems.length === 0
  return {
    ok,
    environment,
    binding: expectedBinding,
    databaseId: ok ? id : undefined,
    problems,
  }
}
