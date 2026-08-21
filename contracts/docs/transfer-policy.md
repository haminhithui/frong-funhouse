# FRONG Catch — Trophy transfer policy (research + recommendation)

> **Status: DECIDED (owner, 2026-08-20).** The trophy is a **standard, freely
> transferable ERC-721**. There is NO protocol transfer fee, tax, royalty,
> allowlist, cooldown, or transfer restriction in normal operation - only
> unavoidable network gas. Owner/approved authorization semantics are the
> plain ERC-721 ones (approve / setApprovalForAll / transferFrom /
> safeTransferFrom). No transfer-fee code is implemented; the constructor
> `soulbound` flag is deployed `false` and the D1 test pins the free-transfer
> semantics (approvals + safeTransferFrom + no EIP-2981 interface).
>
> **Context:** FRONG Catch mints one ERC-721 trophy per finished paid run,
> directly to the verified player wallet, with gas sponsored by the operator.
> There is **no marketplace**, the economy is **FRONG-denominated**, and the
> only reward is the trophy itself. This document surveys the industry-standard
> ways to attach a fee or a transfer restriction to an ERC-721 and recommends
> exactly one for FRONG Catch.

---

## 1. What we are deciding

The spec (`.hermes/frong-catch-v2-spec.md` §7) leaves
"transferable vs soulbound" as a PENDING OWNER parameter and separately asks
whether a transfer fee makes sense. The options below cover both "charge on
transfer" and "restrict transfer" designs. They are **not** mutually exclusive,
but FRONG Catch should pick exactly one behaviour and hold it.

Hard invariants that constrain the choice (spec §1, §10):

1. FRONG flows exactly one way: player → game. Never game → player.
2. The game never mints, burns, pays out, or enables withdrawal of FRONG.
3. The only reward of any kind is the ERC-721 trophy NFT.
4. No marketplace exists or is planned this phase.

---

## 2. Survey of industry-standard designs

### 2.1 EIP-2981 royalties (marketplace-dependent) — NOT SUITABLE

EIP-2981 (`royaltyInfo(tokenId, salePrice)`) declares a royalty the
**marketplace** is _supposed_ to pay to a recipient on secondary sales. It is:

- **Marketplace-dependent:** it is a signalling interface, not an enforcement
  mechanism. A direct peer-to-peer transfer (plain `transferFrom`) pays nothing.
- **Secondary-sale only:** it has no effect on the primary mint and no effect on
  a holder who simply wants to move the token to another of their own wallets.
- **Denominated in the sale's currency:** royalties are paid in whatever the
  marketplace settles in (ETH/USDC), not FRONG.

Because FRONG Catch has **no marketplace** and the economy is FRONG-only, EIP-2981
provides zero value here and is explicitly ruled out.

Sources:

- <https://eips.ethereum.org/EIPS/eip-2981>
- <https://docs.openzeppelin.com/contracts/5.x/api/token/common#ERC2981>

### 2.2 On-chain transfer fee via `_update` override — POSSIBLE but ruled out

A transfer fee can be enforced on-chain by overriding ERC-721's `_update`
hook (OZ 5.x) and, on every non-mint/non-burn transfer, requiring the sender to
also pay `fee` FRONG to the contract (native coin or FRONG):

```solidity
function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
    if (auth != address(0) && to != address(0)) {
        // mint has auth == 0; burn has to == 0
        require(fee == 0 || IERC20(frong).transferFrom(msg.sender, address(this), fee), "fee");
    }
    return super._update(to, tokenId, auth);
}
```

Properties:

- **Enforced on-chain** for every transfer, independent of marketplaces.
- **FRONG-denominated** fits the economy.
- **UX/gas cost:** every transfer becomes two wallet actions (approve FRONG +
  transfer NFT) or requires the fee payer to be `msg.sender`; for a gas-
  sponsored trophy the sponsor would need to pre-approve FRONG on behalf of the
  player, which is awkward.
- **Semantic mismatch:** charging a _fee to transfer your own reward_ is hostile
  to the player and adds friction with no marketplace to justify it.

Trade-off: technically sound, but it taxes a behaviour (self-custody transfer)
that FRONG Catch has no reason to monetise. Ruled out unless the owner later
adds a marketplace.

Source:

- <https://docs.openzeppelin.com/contracts/5.x/api/token/erc721#ERC721-_update-address-address-uint256-address->
- EIP-2981/ERC-721 discussion: <https://eips.ethereum.org/EIPS/eip-2981>

### 2.3 Soulbound / no-transfer — RECOMMENDED

A soulbound token blocks ordinary transfers so the trophy stays bound to the
verified wallet that earned it. The standard form is EIP-5192 ("Minimal
Soulbound NFTs"), which adds a `locked(tokenId)` view; the enforcement is the
same `_update` override that the current `FrongTrophy` already ships for its
`soulbound` constructor flag:

```solidity
function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
    if (soulbound) {
        require(to == address(0) || auth == address(0), "Trophy: soulbound");
    }
    return super._update(to, tokenId, auth);
}
```

Properties:

- **One-way enforcement, zero fee, zero extra gas** beyond the existing revert
  path; the `auth == address(0)` carve-out already lets the team minter burn
  (recover a mis-mint) without unlocking transfers.
- **No marketplace needed;** nothing to signal or split.
- **Perfect fit for "the reward is the trophy":** the trophy is a proof-of-play
  artefact, not a tradeable asset this phase.

Trade-off: the trophy cannot be sold/gifted later. If the owner later wants a
secondary market, this becomes a one-way door (a non-upgradeable contract
cannot un-soulbound). Mitigation: keep the `soulbound` constructor flag so the
choice is fixed per deployment, and record it in `ownership.md`/deployment
manifest so a future upgrade path (or fresh deploy) is an explicit decision.

Source:

- <https://eips.ethereum.org/EIPS/eip-5192>

### 2.4 Transfer time-locks — ruled out

Delaying a transfer (or restricting transfers to N days after mint) adds no
safety here: there is no marketplace front-running or reward-gaming vector it
would close, and it degrades UX (players expect to move the trophy to cold
storage freely). Not needed.

### 2.5 Operator-filter registries (OpenSea) — ruled out / deprecated

The OperatorFilterRegistry (and similar creator-fee registries) let a contract
blacklist marketplaces that do not honour royalties. OpenSea announced the
deprecation/sunset of operator filtering and shifted to optional, marketplace-
opt-in royalty enforcement. For a no-marketplace game this is doubly irrelevant,
and depending on a deprecated registry is a maintenance liability.

Source:

- <https://github.com/ProjectOpenSea/operator-filter-registry>
- OpenSea creator-fees sunset announcement (2024–2025).

### 2.6 ERC-4906 / ERC-7496 — context only, not a transfer policy

- ERC-4906 (`MetadataUpdate` / `BatchMetadataUpdate`) is a _metadata-refresh
  signal_ for marketplaces — irrelevant with no marketplace, and FRONG Catch's
  tokenURI is immutable at mint anyway.
- ERC-7496 (dynamic traits) standardises on-chain/off-chain dynamic traits; FRONG
  Catch's attestation struct is already on-chain and static per token, so 7496
  adds nothing this phase.

Sources:

- <https://eips.ethereum.org/EIPS/eip-4906>
- <https://eips.ethereum.org/EIPS/eip-7496>

---

## 3. Recommendation (exact)

**Soulbound / no-transfer — deploy `FrongTrophy` with `soulbound = true`.**

Rationale against the FRONG Catch facts:

- **No marketplace** ⇒ royalties (EIP-2981) and operator-filter registries are
  dead weight.
- **FRONG-denominated economy** ⇒ a FRONG transfer fee is the only on-chain fee
  that fits, but it taxes self-custody with no revenue purpose.
- **Gas sponsored, mint-to-player** ⇒ the trophy should be a frictionless
  proof-of-play; a transfer fee or time-lock is pure friction.
- **Only reward = trophy** ⇒ binding it to the verified wallet is the honest
  representation of "you earned this run".

Implementation sketch (already present as the `soulbound` flag; the only change
is the deploy-time value):

```solidity
// deploy: FrongTrophy(true)
function _update(address to, uint256 tokenId, address auth)
    internal override returns (address)
{
    if (soulbound) {
        require(to == address(0) || auth == address(0), "Trophy: soulbound");
    }
    return super._update(to, tokenId, auth);
}
```

Gas/UX implications:

- **Gas:** +0 on the mint path (the branch is only evaluated on transfers); the
  only cost is the revert on a blocked transfer (~2,000–4,000 gas of the failed
  call, paid by the would-be sender).
- **UX:** zero for the player — mints land with no action; the only visible
  change is that `transferFrom` reverts. Document the soulbound status in the
  UI copy and in `ownership.md`.

One-way-door note: choosing soulbound on a non-upgradeable contract is
permanent for that deployment. Confirm the owner accepts that before
`deploy:testnet`.

---

## 4. Decision log

| #   | Question                    | Recommendation                 | Status                                           |
| --- | --------------------------- | ------------------------------ | ------------------------------------------------ |
| 1   | Transferable vs soulbound   | Soulbound (`soulbound = true`) | PENDING OWNER — do not implement until confirmed |
| 2   | On-chain FRONG transfer fee | Not needed (no marketplace)    | Ruled out this phase                             |
| 3   | EIP-2981 royalties          | Not needed                     | Ruled out                                        |
| 4   | Operator-filter registry    | Not needed (deprecated)        | Ruled out                                        |
