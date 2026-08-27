-- FRONG Catch Worker — wallet auth: challenges + tokens (migration 0002).
--
-- RECONCILED SHAPE: this migration is the D1 schema half of the Worker auth
-- repository contract in src/auth/repo.ts / test/authRepo.test.ts. The
-- repository and its focused tests are the source of truth for column names
-- and constraints; this file was reconciled to that contract in place
-- (same migration number, no duplicate tables, no column aliases):
--   * wallet_challenges.challenge_id -> id        (repo projects `id AS challengeId`)
--   * wallet_challenges.nonce_hash   -> challenge_hash (repo's digest column,
--     `ON CONFLICT (challenge_hash) DO NOTHING` replay guard)
--   * wallet_challenges.issued_at    -> created_at (repo binds it explicitly;
--     returned as `createdAt`)
--   * wallet_challenges.chain_id     -> dropped. The 46630/4663 chain
--     restriction is NOT lost: it stays enforced on payments.chain_id in
--     migration 0001 (CHECK (chain_id IN (46630, 4663))), which is the FK
--     target of every payment binding here, so a challenge/token can only
--     bind payments on supported chains.
--   * wallet_challenges.payment_id   -> added (nullable, UNIQUE, FK to
--     payments). This is the one-payment-per-challenge backstop the repo's
--     consume guard relies on and classifies as `payment_conflict`.
--   * status enum-membership CHECKs  -> dropped on BOTH tables. The repo
--     contract requires loud read-time rejection of corrupted rows
--     (readChallengeStatus / readTokenStatus throw on any status outside
--     {pending,consumed,expired} / {active,revoked,expired}); a schema CHECK
--     would instead make the corruption unrepresentable and the malformed-
--     state tests unreachable. The coherence CHECK pairs below still keep
--     consumed/revoked state internally consistent.
--
-- Scope: the wallet_challenges table plus the auth_tokens hashed
-- bearer-token table the Worker auth repository (src/auth/repo.ts) and its
-- tests program against. The migration is ADDITIVE and IDEMPOTENT
-- (IF NOT EXISTS everywhere) so re-applying is a no-op, and nothing from
-- 0001 is modified or referenced destructively.
--
-- Apply (documented; do not run as part of this task):
--   npx wrangler d1 migrations apply frong-catch-staging --env staging
--   npx wrangler d1 migrations apply frong-catch-production --env production
--
-- Reverse (manual, destructive, only if the migration was applied by mistake
-- and no rows exist yet): DROP in dependency order —
--   DROP TABLE auth_tokens; DROP TABLE wallet_challenges;
-- plus the DROP INDEX statements below. D1 migrations are forward-only, so
-- rollback is a documented manual step, not an automated down-migration.
--
-- Security invariants (the whole point of these tables):
--   * Only OPAQUE ids and SHA-256 HEX DIGESTS are stored — never a raw
--     challenge nonce, wallet signature, session token, or key material.
--     The raw nonce is handed to the client, and the signature the client
--     returns is verified in-flight and discarded; challenge_hash is the
--     64-char lowercase-hex digest of the challenge payload.
--   * A challenge is one-use: the pending -> consumed transition happens in
--     one guarded statement (identity + status + expiry window + payment
--     binding), and the status/consumed_at CHECK pair keeps consumed state
--     coherent so a consumed row can never be quietly reset or half-consumed.
--   * Challenge identity is unique twice over: id is the PRIMARY KEY (opaque
--     client handle) and challenge_hash is UNIQUE (the digest of the signed
--     payload), so the same challenge can never be reissued.
--   * auth_tokens stores ONLY the SHA-256 lowercase-hex digest of the bearer
--     token (token_hash) — never the token itself, which exists solely in
--     the client's hands and is verified in-flight. Wallet binding is the
--     player column; challenge/payment linkage is by opaque ids only.
--   * Token identity is unique three ways over: id (PRIMARY KEY, opaque row
--     handle), token_hash (UNIQUE digest), and at most one token per
--     challenge / payment (UNIQUE when set), so a retry can never mint a
--     second token for the same binding.
--   * Revocation is one-way and first-write-wins: the guarded
--     'active' -> 'revoked' transition sets revoked_at exactly once, and
--     the status/revoked_at CHECK pair keeps the row coherent so revoked
--     state can never be quietly reset or half-set. 'expired' is terminal.
--
-- Conventions (inherited from 0001):
--   * Timestamps are TEXT ISO-8601 UTC (SQLite/D1 has no datetime type).
--   * Enum-like columns are validated at the repository boundary (loud
--     read-time rejection); coherence pairs stay as CHECK constraints.

PRAGMA foreign_keys = ON;

-- ------------------------------------------------------- wallet_challenges --
-- One row per issued wallet-verification challenge (SIWE-style).
--   id             — opaque handle returned to the client (PK; the repo
--                   generates it and projects it as `challengeId`).
--   challenge_hash — SHA-256 lowercase-hex digest of the challenge payload
--                   to sign; the payload/nonce itself is never stored
--                   (UNIQUE; the repo's replay guard targets it).
--   player         — EVM address of the claiming wallet ('0x' + 40 hex).
--   status         — 'pending' until a verified signature consumes it
--                   exactly once, 'consumed' thereafter (consumed_at is
--                   first-write-wins truth), 'expired' once expires_at
--                   passes first. Membership is validated by the repo.
--   payment_id     — payment bound at consumption, at most one challenge
--                   per payment (UNIQUE when set; NULL while unbound and
--                   while no payment is being authorized).
--
-- One-time consumption is a single guarded statement (src/auth/repo.ts):
--   UPDATE wallet_challenges
--     SET status = 'consumed', consumed_at = :now, updated_at = :now,
--         payment_id = COALESCE(payment_id, :payment)
--     WHERE id = :id AND player = :player
--       AND status = 'pending' AND expires_at > :now
--       AND (payment_id IS NULL OR payment_id = :payment);
-- exactly one affected row means consumed; zero means already used, wrong
-- wallet, expired, or a binding conflict — so retries and replays of the
-- same challenge cannot succeed twice.
CREATE TABLE IF NOT EXISTS wallet_challenges (
  id             TEXT    PRIMARY KEY,
  player         TEXT    NOT NULL
                   CHECK (length(player) = 42
                          AND player GLOB '0x*'
                          AND substr(player, 3) NOT GLOB '*[^0-9a-fA-F]*'),
  challenge_hash TEXT    NOT NULL UNIQUE
                   CHECK (length(challenge_hash) = 64
                          AND challenge_hash NOT GLOB '*[^0-9a-f]*'),
  status         TEXT    NOT NULL DEFAULT 'pending',
  payment_id     TEXT,
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at     TEXT    NOT NULL,
  consumed_at    TEXT,
  updated_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (expires_at > created_at),
  CHECK (status <> 'consumed' OR consumed_at IS NOT NULL),
  CHECK (status = 'consumed' OR consumed_at IS NULL),
  UNIQUE (payment_id),
  FOREIGN KEY (payment_id) REFERENCES payments (id) ON DELETE RESTRICT
);

-- Wallets list their challenges newest-first (player, created_at); expiry
-- sweeps poll open rows (status, expires_at) and every row by hard deadline.
-- id (PK) and challenge_hash (UNIQUE) already carry their own indexes.
CREATE INDEX IF NOT EXISTS idx_wallet_challenges_player_created
  ON wallet_challenges (player, created_at);
CREATE INDEX IF NOT EXISTS idx_wallet_challenges_status_expires
  ON wallet_challenges (status, expires_at);
CREATE INDEX IF NOT EXISTS idx_wallet_challenges_expires
  ON wallet_challenges (expires_at);

-- ------------------------------------------------------------ auth_tokens --
-- One row per issued hashed bearer token (the credential half of the wallet
-- auth flow; written by src/auth/repo.ts, not wired to any route yet).
--   id           — opaque row id (PRIMARY KEY; repo-generated UUID, aliased
--                  to `tokenId` in the repo's RETURNING projections).
--   token_hash   — SHA-256 lowercase-hex digest of the bearer token
--                  (UNIQUE); the token itself is never stored, accepted, or
--                  returned by any column. Point lookups (bearer
--                  verification) resolve through this UNIQUE index.
--   player       — EVM address of the authenticated wallet ('0x' + 40 hex).
--                  The ONLY identity a token ever resolves to; a digest
--                  bound to one wallet cannot be re-bound to another.
--   challenge_id — the consumed wallet challenge that proved the wallet,
--                  when known (NULL otherwise). UNIQUE when set: one token
--                  per challenge, the retry/idempotency backstop that makes
--                  a replayed issue resolve to the ORIGINAL token's row.
--   payment_id   — the payment this token authorizes, when bound (NULL
--                  otherwise). UNIQUE when set: one token per payment.
--                  FK to 0001's payments (where chain_id IN (46630, 4663)
--                  is still enforced), RESTRICT to preserve the trail.
--   status       — 'active' from issue, 'revoked' after the one-way
--                  revocation (revoked_at is first-write-wins truth),
--                  'expired' once expires_at passes first (terminal).
--                  Membership is validated by the repo.
--
-- Lifecycle transitions are single guarded statements (mirroring
-- src/auth/repo.ts, exactly like the consume guard above):
--   revoke:  UPDATE auth_tokens
--              SET status = 'revoked', revoked_at = :now, updated_at = :now
--            WHERE token_hash = :digest AND status = 'active';
--   expire:  UPDATE auth_tokens
--              SET status = 'expired', updated_at = :now
--            WHERE token_hash = :digest
--              AND status = 'active' AND expires_at <= :now;
-- exactly one affected row means the transition happened; zero means
-- already-revoked / already-expired / unknown — so replays resolve to the
-- stored first-write-wins truth instead of a second transition, and a
-- revoked row can never be expired (or re-revoked) afterwards.
CREATE TABLE IF NOT EXISTS auth_tokens (
  id            TEXT    PRIMARY KEY,
  token_hash    TEXT    NOT NULL UNIQUE
                  CHECK (length(token_hash) = 64
                         AND token_hash NOT GLOB '*[^0-9a-f]*'),
  player        TEXT    NOT NULL
                  CHECK (length(player) = 42
                         AND player GLOB '0x*'
                         AND substr(player, 3) NOT GLOB '*[^0-9a-fA-F]*'),
  challenge_id  TEXT,
  payment_id    TEXT,
  status        TEXT    NOT NULL DEFAULT 'active',
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at    TEXT    NOT NULL,
  revoked_at    TEXT,
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (challenge_id),
  UNIQUE (payment_id),
  CHECK (expires_at > created_at),
  CHECK (status <> 'revoked' OR revoked_at IS NOT NULL),
  CHECK (status = 'revoked' OR revoked_at IS NULL),
  FOREIGN KEY (challenge_id) REFERENCES wallet_challenges (id)
    ON DELETE RESTRICT,
  FOREIGN KEY (payment_id) REFERENCES payments (id) ON DELETE RESTRICT
);

-- Bearers resolve by digest (token_hash UNIQUE carries its own index) and
-- duplicate-binding retries are caught by the UNIQUE (challenge_id) /
-- UNIQUE (payment_id) backstops above. Wallets list their tokens
-- newest-first (player, created_at); expiry sweeps poll open rows
-- (status, expires_at) and every row by hard deadline.
CREATE INDEX IF NOT EXISTS idx_auth_tokens_player_created
  ON auth_tokens (player, created_at);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_status_expires
  ON auth_tokens (status, expires_at);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_expires
  ON auth_tokens (expires_at);
