# Minter custody & KMS model (D9)

> Status: adapter is CODE-ONLY. No KMS key has been provisioned, no AWS
> credentials exist in this repo, and no production signing has occurred.
> All placeholders below are EMPTY and must stay empty in `.env`.

## Signing paths

| Mode   | Config                                             | Where              | Notes                                                                                                     |
| ------ | -------------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------- |
| `kms`  | `KMS_REGION` + `KMS_KEY_ID` + `KMS_MINTER_ADDRESS` | production         | The ONLY production path. Plaintext `MINTER_KEY` is IGNORED when KMS is configured.                       |
| `env`  | `MINTER_KEY`                                       | dev / testnet only | Local hot key. The factory THROWS in `NODE_ENV=production` with a plaintext key and no KMS (fail closed). |
| `none` | neither                                            | tests / disabled   | Records stay `queued`; minting is disabled, never faked.                                                  |

Selection lives in `src/signer.ts` (`createSigner` / `createSignerSafe`) and is
injected into `MintWorker`. The key material never leaves the signer:
`AwsKmsSigner` sends only digests (`MessageType: DIGEST`,
`SigningAlgorithm: ECDSA_SHA_256`) to KMS and recovers `yParity` locally
against the configured minter address. Nothing is logged or persisted.

## Environment (all EMPTY placeholders - masked, never real values)

```
KMS_REGION=            # e.g. us-east-1 (when provisioned, separately authorized)
KMS_KEY_ID=            # KMS key id / ARN (never a private key)
KMS_MINTER_ADDRESS=    # minter's PUBLIC address (not secret)
MINTER_KEY=            # dev/testnet ONLY - empty in production
OPERATOR_TOKEN=        # recovery endpoint credential; random >=32 chars in production
```

## Rotation

1. Create a new asymmetric KMS key (ECC_SECG_P256K1) in the region.
2. Set `KMS_MINTER_ADDRESS` to the new key's derived address and deploy the
   server with the new `KMS_KEY_ID` (blue/green, or brief pause).
3. On-chain: admin calls `FrongTrophy.setMinter(newAddress, true)` then
   `setMinter(oldAddress, false)` (contract admin is 2-step multisig-ready).
4. Verify: one test mint from the new address; revoke the old key's grant.

## Emergency stop

- `FrongTrophy.pause()` (admin) blocks ALL mints immediately - the first
  circuit breaker.
- Revocation: `setMinter(address, false)` removes the leaked signer; the
  sliding rate cap (100/hour) bounds damage before revocation lands.
- The mint queue never double-mints: `ownerOf` idempotency plus ERC-721
  duplicate-id revert.

## Terminal queue recovery

After five bounded mint attempts, a record enters `delayed` and remains
terminal until an operator explicitly requeues it. The recovery endpoint is
`POST /api/admin/mints/:tokenId/requeue` with `X-Operator-Token`; it refuses
records that already have a transaction hash and never accepts a wallet bearer
token as an operator credential. Configure the credential through
`OPERATOR_TOKEN`, keep it outside the repository, and rotate it through the
deployment secret manager.

## Least privilege

- The KMS key policy allows `Sign` ONLY for the game server role, on the
  trophy chain's minter key - no admin, no treasury, no `Sign` for anyone
  else.
- The minter address is NOT the contract admin and NOT the deployer.
- `MINTER_KEY` must never appear in any `.env`, dotfile, log, or commit.

## Testnet vs mainnet

- Testnet 46630: `env` mode hot key is acceptable; rotate it like any key.
- Mainnet 4663: `kms` mode only; provisioning, key policy, and rotation
  drill are SEPARATE authorization steps (NOT-RUN in this repo).
