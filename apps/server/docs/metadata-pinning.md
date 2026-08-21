# Metadata pinning (D7)

> Status: adapter is CODE-ONLY. No Pinata account/JWT has been provisioned
> and nothing has been pinned. Production pinning stays DISABLED until real
> provider credentials are separately authorized.

## Pinner interface (`src/pinner.ts`)

- `MetadataPinner.pinMetadata(tokenId, metadata)` returns `{ uri, cid }` or
  THROWS. The mint queue treats a throw as `delayed` and NEVER mints with a
  placeholder URI - no pin, no mint.
- `validateMetadata` runs on every pin: plain JSON object, required fields
  (`name`, `description`, `image`, `attributes`), stable JSON round-trip,
  and no secret-shaped keys anywhere in the tree.

## Implementations

| Pinner            | When                                       | URI                                                              |
| ----------------- | ------------------------------------------ | ---------------------------------------------------------------- |
| `PinataPinner`    | `PINATA_JWT` set (production path)         | `ipfs://<cid>` via the official `pinata` SDK (JSON content type) |
| `FailingPinner`   | `NODE_ENV=production` without `PINATA_JWT` | never returns - throws (fail closed)                             |
| `LocalFilePinner` | dev/test without `PINATA_JWT`              | `METADATA_BASE_URL/metadata/<id>.json` (local data dir)          |

Factory: `createPinner(config)` in `src/pinner.ts`; injected into
`MintWorker` (default) or tests (mocks).

## Deferred wiring (needs separate authorization)

- Provision a Pinata account + JWT and set `PINATA_JWT` / `PINATA_GATEWAY`.
- Pin the six tier images (`/assets/tiers/<tier>.png`) and point
  `METADATA_BASE_URL` at the public gateway so `/api/config` consumers and
  wallets can resolve images.
- Enable production mode (`NODE_ENV=production`) with KMS config - the
  pinner then requires `PINATA_JWT`, otherwise every mint stays delayed.
