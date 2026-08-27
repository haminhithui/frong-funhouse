-- FRONG Catch Worker — initial D1 schema (migration 0001).
--
-- Scope: payments, sessions, attestations, mint_jobs, and an append-only
-- audit_events ledger. This migration is ADDITIVE and IDEMPOTENT
-- (IF NOT EXISTS everywhere) so re-applying is a no-op.
--
-- Apply (documented; do not run as part of this task):
--   npx wrangler d1 migrations apply frong-catch-staging --env staging
--   npx wrangler d1 migrations apply frong-catch-production --env production
--
-- Reverse (manual, destructive, only if the migration was applied by mistake
-- and no rows exist yet): DROP TRIGGER/TRIGGER/TABLE in dependency order —
--   DROP TRIGGER audit_events_no_update; DROP TRIGGER audit_events_no_delete;
--   DROP TABLE audit_events; DROP TABLE mint_jobs; DROP TABLE attestations;
--   DROP TABLE sessions; DROP TABLE payments;
-- plus the DROP INDEX statements below. D1 migrations are forward-only, so
-- rollback is a documented manual step, not an automated down-migration.
--
-- Conventions:
--   * Timestamps are TEXT ISO-8601 UTC (SQLite/D1 has no datetime type).
--   * wei amounts are TEXT (uint256 exceeds JS safe integers).
--   * Foreign keys use ON DELETE RESTRICT to preserve the audit trail.
--   * Enum-like columns are guarded by CHECK constraints.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- payments --
-- One row per on-chain fee payment. Idempotency is guaranteed twice:
--   * (chain_id, tx_hash)  — the same transaction can never pay twice;
--   * (player, payment_id) — the client's idempotency key for retries.
CREATE TABLE IF NOT EXISTS payments (
  id             TEXT PRIMARY KEY,
  chain_id       INTEGER NOT NULL CHECK (chain_id IN (46630, 4663)),
  tx_hash        TEXT    NOT NULL CHECK (length(tx_hash) BETWEEN 66 AND 66),
  player         TEXT    NOT NULL CHECK (length(player) BETWEEN 42 AND 42),
  payment_id     TEXT    NOT NULL CHECK (length(payment_id) > 0),
  amount_wei     TEXT    NOT NULL CHECK (length(amount_wei) > 0),
  block_number   INTEGER,
  status         TEXT    NOT NULL DEFAULT 'observed'
                  CHECK (status IN ('observed', 'confirmed', 'consumed', 'rejected')),
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  confirmed_at   TEXT,
  consumed_at    TEXT,
  UNIQUE (chain_id, tx_hash),
  UNIQUE (player, payment_id)
);

CREATE INDEX IF NOT EXISTS idx_payments_status_created ON payments (status, created_at);
CREATE INDEX IF NOT EXISTS idx_payments_player_created ON payments (player, created_at);

-- ---------------------------------------------------------------- sessions --
-- Durable game session bound to a consumed payment. Exactly one session per
-- payment (UNIQUE payment_id); expiry sweeps query (status, expires_at).
CREATE TABLE IF NOT EXISTS sessions (
  session_id    TEXT PRIMARY KEY,
  payment_id    TEXT    NOT NULL,
  player        TEXT    NOT NULL CHECK (length(player) BETWEEN 42 AND 42),
  seed          INTEGER NOT NULL CHECK (seed >= 0),
  build_hash    TEXT    NOT NULL CHECK (length(build_hash) > 0),
  status        TEXT    NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'completed', 'expired', 'consumed')),
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at    TEXT    NOT NULL,
  consumed_at   TEXT,
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (payment_id),
  FOREIGN KEY (payment_id) REFERENCES payments (id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_sessions_status_expires ON sessions (status, expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry        ON sessions (expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_player        ON sessions (player);

-- ------------------------------------------------------------ attestations --
-- Immutable proof of a scored run: one per session (UNIQUE session_id).
-- token_id stays NULL until the mint confirms, then becomes UNIQUE.
CREATE TABLE IF NOT EXISTS attestations (
  id               TEXT PRIMARY KEY,
  session_id       TEXT    NOT NULL,
  player           TEXT    NOT NULL CHECK (length(player) BETWEEN 42 AND 42),
  tier             INTEGER NOT NULL CHECK (tier >= 0),
  tier_name        TEXT    NOT NULL CHECK (length(tier_name) > 0),
  score            INTEGER NOT NULL CHECK (score >= 0),
  flies_caught     INTEGER NOT NULL CHECK (flies_caught >= 0),
  seed_commitment  TEXT    NOT NULL CHECK (length(seed_commitment) > 0),
  input_log_hash   TEXT    NOT NULL CHECK (length(input_log_hash) > 0),
  build_hash       TEXT    NOT NULL CHECK (length(build_hash) > 0),
  uri              TEXT,
  metadata         TEXT,            -- JSON blob, opaque to the schema
  token_id         INTEGER UNIQUE,
  created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  attested_at      TEXT    NOT NULL,
  UNIQUE (session_id),
  FOREIGN KEY (session_id) REFERENCES sessions (session_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_attestations_player_created ON attestations (player, created_at);
CREATE INDEX IF NOT EXISTS idx_attestations_token          ON attestations (token_id);

-- --------------------------------------------------------------- mint_jobs --
-- Queue state for minting a trophy, separated from the immutable attestation.
-- One job per attestation (UNIQUE attestation_id); workers poll by
-- (status, next_attempt_at). tx_hash is UNIQUE when set: one tx per job.
CREATE TABLE IF NOT EXISTS mint_jobs (
  id               TEXT PRIMARY KEY,
  attestation_id   TEXT    NOT NULL,
  status           TEXT    NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued', 'minting', 'minted', 'delayed', 'rejected')),
  attempts         INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts     INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts >= 1),
  next_attempt_at  TEXT,
  tx_hash          TEXT UNIQUE,
  last_error       TEXT,
  created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at     TEXT,
  UNIQUE (attestation_id),
  FOREIGN KEY (attestation_id) REFERENCES attestations (id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_mint_jobs_status_next   ON mint_jobs (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_mint_jobs_status_updated ON mint_jobs (status, updated_at);

-- ------------------------------------------------------------ audit_events --
-- Append-only, hash-chained audit ledger (replaces the Node store's audit
-- chain). UPDATE and DELETE are rejected by triggers so history is immutable
-- even against buggy future code; seq is monotonic via AUTOINCREMENT.
CREATE TABLE IF NOT EXISTS audit_events (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  id            TEXT    NOT NULL UNIQUE,
  event_type    TEXT    NOT NULL CHECK (length(event_type) > 0),
  actor         TEXT,
  subject_type  TEXT,
  subject_id    TEXT,
  payload       TEXT,            -- JSON blob, opaque to the schema
  prev_hash     TEXT    NOT NULL,
  entry_hash    TEXT    NOT NULL UNIQUE,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_events_type_created   ON audit_events (event_type, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_events_subject        ON audit_events (subject_type, subject_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_events_created        ON audit_events (created_at);

CREATE TRIGGER IF NOT EXISTS audit_events_no_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only: UPDATE is not allowed');
END;

CREATE TRIGGER IF NOT EXISTS audit_events_no_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only: DELETE is not allowed');
END;
