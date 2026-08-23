# FRONG Catch quality remediation

This document is the versioned release checklist for the quality audit. The
ignored `.hermes/` files remain design material; this file records controls
that must travel with the repository.

## Implemented controls

- Payment transaction hashes are persisted in browser storage immediately after
  the wallet returns a hash. The UI recovers the same `paymentId` and hash and
  never offers a second payment while recovery is possible. A consumed
  recovery marker is cleared only after the server proves that the run was
  already accepted, and a pending payment blocks wallet switching so one
  browser marker cannot be overwritten by a second charge.
- Auth bearer tokens are stored only as SHA-256 digests in the server's
  hash-chained `auth.jsonl` journal. Payment sessions and the one-use consumed
  transition are durably bound to the payment journal.
- Accepted submissions are replay-idempotent: the attestation is journaled
  before the consumed marker, and a retry returns the original token instead
  of creating a second token or losing a paid session during a crash window.
- Mint status is wallet-authenticated. The public attestation list excludes
  wallet addresses, session ids, and full metadata records.
- Unexpected server errors return a generic 500; malformed/oversized input has
  explicit 400/413 responses. API and metadata responses carry baseline
  security headers.
- Terminal mint records can be requeued only with the separate
  `X-Operator-Token` credential through `POST /api/admin/mints/:tokenId/requeue`.
- The Store acquires an fsynced cross-process lock for each resolved `DATA_DIR`,
  detects tampered or unchained journal records, and stops state-changing API
  requests and mint workers when persistence integrity is broken.
- Privy access and identity tokens must belong to the same user. Server config
  validates ports, production RPC URLs, nonzero contract/KMS addresses, fee and
  rate bounds, complete production KMS settings, and the explicit-only
  incomplete-config escape hatch.
- `FrongEntry` price changes have a 24-hour timelock. Pause/minter/rate-cap
  changes emit audit events, and deployment scripts use strict received-amount
  accounting. Testnet/finalization preflight validates nonzero addresses,
  distinct authorities, governance bytecode, and the deployed on-chain
  invariants before ownership or mint authority is proposed.
- Remote X oEmbed markup is sanitized into an allowlisted DOM fragment before
  it is inserted; scripts, handlers, styles, and foreign links are discarded.
- X widget timeout retries invalidate the cached loader, and KMS ECDSA
  signatures are normalized to EIP-2 low-S form before transaction encoding.
- Production boot rejects incomplete configuration even when the development
  `ALLOW_INCOMPLETE_CONFIG` escape hatch is present; API clients validate
  successful response shapes before entering a paid flow.
- Root, server, and contracts production dependency trees pass
  `npm audit --omit=dev`. All three workspaces pass `npm ci --dry-run` from
  their lockfiles.

## Verification evidence and tool limits

- Root: typecheck, ESLint, Prettier, 146 Vitest tests, production build,
  simulation hash, and entry bundle budget pass. The real local EVM harness
  also passed the payment-to-mint flow and leaves port 8545 free after exact
  Hardhat child-process cleanup.
- Server: typecheck, ESLint, Prettier, 95 Vitest tests, the cross-process Store
  lock harness, and the real-chain
  integration test pass. The one no-chain unit-run skip is expected; CI/local
  E2E covers it with a live Hardhat node.
- Contracts: compile, TypeScript typecheck, and 29 Hardhat tests pass, and the
  strict-received deployment path was exercised by the real E2E.
- The direct production-like boot check fails closed on incomplete KMS and
  mainnet configuration, even when `ALLOW_INCOMPLETE_CONFIG=1` is set.
- `slither`, `echidna-test`, and `semgrep` are not installed in the current
  Windows environment. No external scanner result is claimed; install and run
  those tools in the security-review environment before a production release.
- A full contracts `npm audit` still reports 19 development-toolchain findings
  through Hardhat 2. The CI gate intentionally audits production dependencies
  with `--omit=dev`; upgrading Hardhat is a separate breaking migration, not a
  safe automatic `npm audit fix --force` operation.

## Release requirements still requiring external authorization

- Deploy `FrongEntry.owner` and `FrongTrophy.admin` to the Safe/multisig
  proposed by `GOVERNANCE_ADDRESS`, then accept both rotations after the
  24-hour timelock. Do not ship with the deployer EOA as the active authority.
- Configure `OPERATOR_TOKEN`, KMS custody, Pinata, exact production CORS
  origins, `HOST=0.0.0.0` behind TLS, and the production metadata URL.
- The Store now takes an exclusive process lock per `DATA_DIR` and fails closed
  on a second process. A multi-replica deployment still needs a shared
  transactional store and distributed mint-worker lease before it is enabled.
- Run live testnet payment/recovery, wallet matrix, 100-run spectrum tests,
  1000-run/24-hour soak, alert/restore drill, source verification, and an
  independent contract/security review.
- The contracts test toolchain has no production dependencies, but its Hardhat
  2 dependency graph still needs a planned Hardhat 3 migration before treating
  development-tool audit output as clean.
