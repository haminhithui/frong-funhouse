# FRONG Catch — ownership & admin model

> **Status:** documents the multisig-ready admin design on `FrongTrophy` and
> the result of the Safe-on-Robinhood-Chain deployment check. No code in this
> document does anything beyond record the decisions.

---

## 1. Admin is a plain address (Safe-compatible)

`FrongTrophy.admin` is a single `address`, not a role-bearing account. That
is deliberate: a Gnosis Safe (or any multisig) is an ordinary contract address,
so setting `admin` to a Safe address gives the Safe's owners the admin powers
(pause, unpause, setMinter, setRateCap, proposeAdmin) through the Safe's own
threshold signing — no changes to the contract are required.

`FrongEntry.owner` stays a plain address for the same reason and now uses the
same 2-step rotation pattern as the trophy `admin`. Treasury/gas-reserve
rotation on `FrongEntry` uses its own 2-step timelock (see D5/D10).

`FrongEntry.setPrice` is also a propose → accept operation. The new price is
held in `pendingPrice` for `PRICE_TIMELOCK` (24 hours) before the owner may
call `acceptPrice()`. A payment always emits the price actually charged in its
`Paid` event, so a later price change cannot rewrite payment history.

The deployer is intentionally temporary. `deploy-testnet.ts` requires a
distinct `GOVERNANCE_ADDRESS`, grants the separate `MINTER_ADDRESS`, then
proposes the Safe/multisig as both entry owner and trophy admin. The rotation
must be accepted after the timelock before a release is considered governed.

---

## 2. Two-step admin transfer (D8)

The trophy admin cannot be changed in a single transaction. It follows a
propose → accept handshake with a 24-hour timelock so the current admin (a
multisig, once set) has a review window before a transfer finalises.

State:

| Field             | Type                 | Meaning                                            |
| ----------------- | -------------------- | -------------------------------------------------- |
| `admin`           | `address`            | Current admin (deployer at construction).          |
| `pendingAdmin`    | `address`            | Proposed successor.                                |
| `adminProposedAt` | `uint256`            | `block.timestamp` when the successor was proposed. |
| `ADMIN_TIMELOCK`  | `uint256` (constant) | `24 hours`.                                        |

Flow:

1. `proposeAdmin(newAdmin)` — `onlyAdmin`. Rejects the zero address. Sets
   `pendingAdmin = newAdmin` and `adminProposedAt = block.timestamp`. Emits
   `AdminProposed(newAdmin, proposedAt)`.
2. `acceptAdmin()` — callable **by `pendingAdmin`** (the successor claims the
   role), and only after `block.timestamp >= adminProposedAt + ADMIN_TIMELOCK`.
   Moves `admin = pendingAdmin`, clears `pendingAdmin`/`adminProposedAt`,
   and emits `AdminAccepted(previousAdmin, newAdmin, acceptedAt)`.

Security properties:

- The successor cannot self-install instantly — the 24h window gives the
  current admin (or the Safe's owners) time to notice an erroneous proposal.
- A proposal has no effect until accepted; proposing again simply overwrites
  `pendingAdmin` and restarts the clock.
- `acceptAdmin` is gated on `msg.sender == pendingAdmin`, so only the
  proposed successor can finalise.

Note: the current admin cannot "cancel" a proposal today (there is no
`cancelAdmin`). If that becomes desirable it is a small, backwards-compatible
addition (a new `onlyAdmin` function that clears `pendingAdmin`). Not
required by D8 and intentionally left out to keep the surface minimal.

---

## 3. Is Safe deployed on Robinhood Chain 46630? — YES (verified)

Read-only `eth_getCode` against the official testnet RPC
(`https://rpc.testnet.chain.robinhood.com/rpc`, `eth_chainId` → `0xb626` = 46630) on the canonical Safe v1.3.0 addresses shows all core singletons are
deployed:

| Address                                      | Role                                | Result                  |
| -------------------------------------------- | ----------------------------------- | ----------------------- |
| `0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2` | SafeProxyFactory v1.3.0             | DEPLOYED (7,550 bytes)  |
| `0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552` | Safe singleton v1.3.0               | DEPLOYED (45,918 bytes) |
| `0x3E5c63644E683549055b9Be8653de26E0B4CD36E` | SafeL2 singleton v1.3.0             | DEPLOYED (47,602 bytes) |
| `0xf48f2B2d2a534e402487b3ee7C18c33Aec0Fe5e4` | CompatibilityFallbackHandler v1.3.0 | DEPLOYED (10,986 bytes) |
| `0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7` | Safe singleton factory              | DEPLOYED (140 bytes)    |

These are the canonical v1.3.0 addresses deployed through Safe's deterministic
singleton factory, so a Safe can be created on 46630 with the standard Safe UI /
`safe-cli` / the Safe transaction service. The team can therefore:

1. Create a Safe on 46630 (threshold `m/n`).
2. `FrongTrophy.proposeAdmin(safeAddress)` from the current admin.
3. After 24h, execute `acceptAdmin()` from the Safe so `admin` becomes the
   Safe address.

Mainnet (4663) was **not** checked in this task (no mainnet RPC was configured,
and mainnet is out of scope for these changes). The same canonical singleton
factory is expected to have deployed these contracts on the mainnet OP-Stack
chain, but that must be re-verified from the official mainnet RPC before any
mainnet promotion (spec M-list).

Sources:

- Safe canonical addresses:
  <https://github.com/safe-global/safe-smart-account/blob/main/docs/safe_singleton_factory.md>
  and <https://github.com/safe-global/safe-deployments>
- EIP-5192 / soulbound (trophy transfer policy): see `contracts/docs/transfer-policy.md`.

---

## 4. Decision log

| #   | Decision                                                      | Status                                           |
| --- | ------------------------------------------------------------- | ------------------------------------------------ |
| 1   | `admin` is a plain `address`, Safe-compatible by construction | Done (this phase)                                |
| 2   | 2-step admin transfer with 24h timelock on `FrongTrophy`      | Implemented (D8)                                 |
| 3   | Safe is deployed on 46630 (all v1.3.0 singletons present)     | Verified read-only                               |
| 4   | Trophy soulbound vs transferable                              | Transferable (`soulbound = false`) — implemented |
