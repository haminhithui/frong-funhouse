# FRONG Catch Worker — Environment & Binding Contract

Status: **schema + configuration contract only.** No endpoints, signer, minting,
or deployment logic has been migrated yet. The Worker runtime code
(`src/index.ts`) is unchanged in this phase.

This file is documentation; the live configuration is `wrangler.json`
(bindings + non-secret vars). **No real values, IDs, tokens, or private keys
belong in either file.**

---

## 1. Environment matrix

|                  | local dev            | `staging` env                   | `production` env                   |
| ---------------- | -------------------- | ------------------------------- | ---------------------------------- |
| Wrangler context | top-level config     | `wrangler.json` → `env.staging` | `wrangler.json` → `env.production` |
| Worker name      | `frong-catch-worker` | `frong-catch-worker-staging`    | `frong-catch-worker-production`    |
| Network          | testnet              | testnet                         | mainnet                            |
| `CHAIN_ID`       | `46630`              | `46630`                         | `4663`                             |
| D1 database_name | `frong-catch-local`  | `frong-catch-staging`           | `frong-catch-production`           |
| D1 `database_id` | placeholder — see §2 | placeholder — see §2            | placeholder — see §2               |

Staging (testnet 46630) and production (mainnet 4663) are **fully separate**:
distinct Worker names, distinct `vars` blocks, and **distinct D1 databases**
with distinct `database_id` values. A staging migration or write can never
touch production data.

## 2. D1 binding & provisioning (documented step — not run in this task)

The single binding is named **`DB`** (`env.DB` in Worker code). Every
`database_id` in `wrangler.json` is currently the literal placeholder
`REPLACE_WITH_D1_DATABASE_ID_LOCAL` / `..._STAGING` / `..._PRODUCTION`.
Placeholders are safe for `wrangler dev` (local simulation) but **must** be
replaced before any remote apply. Provision once per environment and paste the
returned UUID over the placeholder:

```
npx wrangler d1 create frong-catch-staging
npx wrangler d1 create frong-catch-production
npx wrangler d1 migrations apply frong-catch-staging   --env staging
npx wrangler d1 migrations apply frong-catch-production --env production
```

No database IDs, contract addresses, or account IDs are invented here.

## 3. Non-secret Worker `vars` (safe to commit; all values are strings)

| Var                                                  | local / staging value                                            | production value                                | Notes                                                                                                               |
| ---------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `ENVIRONMENT`                                        | `local` / `staging`                                              | `production`                                    | Selects env-specific behavior.                                                                                      |
| `NETWORK`                                            | `testnet`                                                        | `mainnet`                                       | Human-readable network label.                                                                                       |
| `CHAIN_ID`                                           | `46630`                                                          | `4663`                                          | Robinhood Chain testnet / mainnet.                                                                                  |
| `RPC_URL`                                            | official testnet RPC (pinned from official docs, already public) | _(empty — pin from official docs, never guess)_ | Server-side JSON-RPC endpoint.                                                                                      |
| `EXPLORER_URL`                                       | official testnet explorer                                        | _(empty — same rule)_                           | Link building only.                                                                                                 |
| `CONFIRMATIONS`                                      | `1`                                                              | `1`                                             | Block confirmations before a payment is accepted.                                                                   |
| `SESSION_TTL_MS`                                     | `600000`                                                         | `600000`                                        | Paid game session lifetime (10 min).                                                                                |
| `AUTH_TTL_MS`                                        | `1800000`                                                        | `1800000`                                       | Auth-token lifetime (30 min).                                                                                       |
| `RATE_LIMIT_PER_MIN`                                 | `30`                                                             | `30`                                            | Request-abuse token bucket; paid attempts are never capped.                                                         |
| `RATE_LIMIT_BURST`                                   | `60`                                                             | `60`                                            | Bucket burst capacity.                                                                                              |
| `CHALLENGE_RATE_PER_MIN`                             | `10`                                                             | `10`                                            | Stricter `/api/challenge` limit.                                                                                    |
| `CORS_ORIGINS`                                       | _(empty = dev default)_                                          | **set at deploy time**                          | Comma-separated allowlist.                                                                                          |
| `METADATA_BASE_URL`                                  | _(empty in repo)_                                                | **set at deploy time**                          | Public base URL for `/metadata/<id>.json`.                                                                          |
| `FRONG_ADDRESS` / `ENTRY_ADDRESS` / `TROPHY_ADDRESS` | _(empty)_                                                        | _(empty)_                                       | Contract addresses come from `contracts/deployments`; fill per env at deploy time. Not secrets, but not inventable. |
| `PRIVY_APP_ID`                                       | _(empty)_                                                        | _(empty)_                                       | Public Privy app id (the client already holds it).                                                                  |
| `PINATA_GATEWAY`                                     | _(empty)_                                                        | **set at deploy time**                          | Metadata pinning gateway host.                                                                                      |
| `KMS_REGION` / `KMS_KEY_ID` / `KMS_MINTER_ADDRESS`   | _(empty)_                                                        | _(empty)_                                       | KMS signer config; the address is public, key material never appears here.                                          |

## 4. Secrets — **names only**, never values

Set per environment with `npx wrangler secret put <NAME> --env <env>` and never
committed. `.dev.vars.example` lists the same names with empty placeholders for
Wrangler's local-only binding format. Do not keep a persistent `.dev.vars`; the
repo's single live local env file is the root `.env`, while staging/production
secrets remain in Wrangler's remote secret store.

| Secret name              | Purpose                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| `MINTER_KEY`             | Hot-wallet private key for minting (ignored when KMS config is complete).                   |
| `PRIVY_APP_SECRET`       | Privy server-side verification.                                                             |
| `PRIVY_VERIFICATION_KEY` | Optional Privy verification key (JWT verification).                                         |
| `OPERATOR_TOKEN`         | Random ≥32-char token for mint requeue/recovery operations.                                 |
| `PINATA_JWT`             | Pinata provider secret for metadata pinning. Minting fails closed without it in production. |

## 5. Public / frontend variables (unchanged, owned by the Vite client)

These stay in the root `.env.example` (repo root) and are **not** Worker vars.
Listed here so the full contract is in one place:

`VITE_SERVER_URL`, `VITE_RPC_URL_46630`, `VITE_EXPLORER_URL_46630`,
`VITE_RPC_URL_4663`, `VITE_EXPLORER_URL_4663`, `VITE_WC_PROJECT_ID`,
`VITE_APP_NAME`, `VITE_APP_DESCRIPTION`, `VITE_APP_URL`, `VITE_APP_ICONS`,
`VITE_PRIVY_APP_ID`, `VITE_PRIVY_LOGIN_METHODS`.

After the Worker migrates the game API, `VITE_SERVER_URL` will point at the
Worker route; that switch is a later task.

## 6. Node-only settings removed or replaced by the migration

| Node server setting                                 | Cloudflare replacement                                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `PORT`, `HOST`                                      | Platform-managed; the Worker has no bind address. **Removed.**                                          |
| `DATA_DIR` + file-based hash-chained store          | D1 binding `DB` (`audit_events` keeps the hash chain). **Replaced.**                                    |
| `ALLOW_MEMORY_ONLY_AUTH_SESSIONS`                   | Durable D1 sessions make the flag meaningless. **Removed.**                                             |
| Process env (`process.env`, `--env-file-if-exists`) | `env` bindings (vars + secrets) in `wrangler.json` / `wrangler secret`. **Replaced.**                   |
| `node:fs` local file pinner (dev)                   | `PINATA_GATEWAY` + `PINATA_JWT` secret everywhere. **Replaced.**                                        |
| In-process mint queue (`mintQueue.ts`)              | D1 `mint_jobs` table polled via `(status, next_attempt_at)`. **Replaced (data model only this phase).** |

## 7. Data model summary (migration `migrations/0001_init.sql`)

- `payments` — idempotent by `UNIQUE (chain_id, tx_hash)` and `UNIQUE (player, payment_id)`.
- `sessions` — one per payment (`UNIQUE payment_id`), indexed on `(status, expires_at)` for expiry sweeps.
- `attestations` — immutable proof, one per session (`UNIQUE session_id`), `token_id UNIQUE` once minted.
- `mint_jobs` — queue state, one per attestation (`UNIQUE attestation_id`), indexed on `(status, next_attempt_at)`.
- `audit_events` — append-only ledger (`AUTOINCREMENT seq`, hash chain columns, triggers reject `UPDATE`/`DELETE`).

All objects use `IF NOT EXISTS`; the migration is additive and re-applying is a
no-op. Manual reversal (destructive, documented in the file header) exists only
for the "applied by mistake before any data" case.
