# Fan-made community site (starter)

A small, independent fan/community one-pager built with **Vite + React 19 + TypeScript (strict)**. It renders verified public X posts as official embeds — no rehosting, no fabricated metrics — inside a dark editorial theme.

> **Demo content:** this repository ships with FRONG (a frog meme) as its demo
> subject — see [Demo content & provenance](#demo-content--provenance). Swap the
> content files and metadata to make it your own; the UI, embed plumbing, and
> tooling stay.

## Features

- **Official X embeds** — oEmbed blockquote transformed by the official widgets script; dark theme; debounced re-render on window resize; wrapper capped at the official 550px width with flush and shell-less card variants.
- **Embedded FRONG Catch arcade** — both game modes live directly in the fan page (`#play`): free walletless practice and the optional paid trophy run (wallet → FRONG entry fee → replay-verified run → ERC-721 trophy). Deterministic seeded fixed-timestep simulation with replay verification, localStorage best score, pointer + keyboard controls, and `prefers-reduced-motion` support.
- **Verified URL-only content model** — posts are just `{ id, url }`; every visible detail (name, handle, text, date, media) is rendered by X at load time. Nothing is staged, rehosted, or invented.
- **Accessible** — semantic landmarks, skip link, visible focus rings, `prefers-reduced-motion` support, no horizontal overflow at 1440px or 375px; the game announces tier crossings via `aria-live`, moves focus between screens, and keeps every fly distinguishable by shape, not color alone.
- **Strict quality tooling** — TypeScript strict, ESLint (TS + React hooks + jsx-a11y), Prettier, Vitest + Testing Library.

## FRONG Catch — paid on-chain phase

The paid skill-game phase of FRONG Catch lives in this repo alongside the fan
site, per the spec in `.hermes/frong-catch-v2-spec.md` (amended by owner
directive: the paid flow is embedded in the fan page behind an explicit
player choice):

- **Paid flow, embedded** — the fan page's `#play` section is a mode menu:
  free practice (no wallet, default) or trophy run. The trophy run
  (`src/paid/PaidApp.tsx`, also available standalone at `paid/index.html`)
  walks W0–W16: injected EIP-1193 wallet or WalletConnect (needs a
  `VITE_WC_PROJECT_ID`), SIWE-style wallet verification, FRONG approve + entry
  payment, seed-bound run with per-tick input logging, auto-submit, replay
  verification, and trophy mint status. No wallet prompt appears until the
  player picks the trophy run.
- **Game server** — `apps/server/` (Node + TS, viem): authoritative for
  challenge/verify, payment validation (receipt + `Paid` + FRONG transfer
  events, one session per payment), seed issuance (CSPRNG + sim build hash
  pinning), input-log replay verification, skill-gated rarity, append-only
  attestation log, and a mint queue that pins metadata then mints from the
  team minter key (never double-mints).
- **Contracts** — `contracts/` (Solidity 0.8.26 + Hardhat, real in-process EVM
  tests): `MockFRONG` (testnet faucet token), `FrongEntry` (exact-amount FRONG
  entry, `Paid` event, pausable, reentrancy-guarded), `FrongTrophy` (ERC-721,
  minter-only mint, on-chain attestation, mint rate cap, optional soulbound).
- **Local end-to-end** — `npm run e2e:local` starts a real Hardhat EVM node,
  deploys, and runs the server integration suite: real faucet/approve/pay
  transactions, real receipt validation, a real mint transaction, and
  on-chain assertions on trophy owner + attestation. Nothing is faked.

External infra required before testnet/mainnet (never invented here): official
Robinhood Chain RPC URLs (pinned from official docs), a WalletConnect Cloud
project id, an IPFS pinner for metadata, a minter key (KMS/HSM for mainnet),
contract audits, and the legal checklist from the spec.

## Requirements

- Node.js 20.19+ (developed and verified on Node 26)
- npm (ships with Node)

## Setup

```powershell
git clone <repository-url>
cd <repository-folder>
npm install
npm run dev
```

Then open <http://localhost:8080/> (host and port are pinned — see [Config](#config)).

## Scripts

| Script                                    | What it does                                                                           |
| ----------------------------------------- | -------------------------------------------------------------------------------------- |
| `npm run dev`                             | Dev server on <http://127.0.0.1:8080> (`strictPort` — fails fast if the port is taken) |
| `npm run build`                           | `tsc -b && vite build` — type-checked production build to `dist/`                      |
| `npm run preview`                         | Serve the production build on <http://127.0.0.1:4173>                                  |
| `npm run typecheck`                       | `tsc -b` across both TS projects                                                       |
| `npm run lint`                            | ESLint (flat config: TS, React hooks, jsx-a11y)                                        |
| `npm run test`                            | Vitest + Testing Library (jsdom)                                                       |
| `npm run format` / `npm run format:check` | Prettier write / check                                                                 |
| `npm run assets`                          | Regenerate the demo image derivatives with sharp                                       |
| `npm run chain:node` / `chain:deploy`     | Local Hardhat EVM node / deploy the three contracts                                    |
| `npm run contracts:test`                  | Contract tests on Hardhat's real in-process EVM                                        |
| `npm run server:dev` / `server:test`      | Game server dev mode / unit + HTTP tests                                               |
| `npm run e2e:local`                       | Full local end-to-end: chain + deploy + server integration suite                       |

## Quality gates

Run all of these before shipping. CI runs the same set (see
[.github/workflows/ci.yml](.github/workflows/ci.yml)):

```powershell
npm run typecheck
npm run lint
npm run format:check
npm run test
npm run build
```

## Repository hygiene

- **Package manager: npm.** CI, lockfiles, and all scripts use npm (`npm ci`,
  `npm install`). Do not commit other package-manager lockfiles.
- **No secrets in the repo, ever.** All `.env` files are gitignored; copy the
  `.env.example` files and fill in your own values. Private keys (deployer,
  minter) are environment-only for dev/testnet and KMS/HSM-backed in
  production — nothing key-shaped is committed. `src/test/paidApp.test.tsx`
  contains a deliberately throwaway fixture key for tests only.
- **Generated dirs stay out of git:** `dist/`, `contracts/artifacts/`,
  `contracts/cache/`, `apps/server/data/` (runtime audit store), `smoke/`
  (QA screenshots), and `*.log` are all covered by `.gitignore`.

## Config

- `vite.config.ts` — dev server pinned to `127.0.0.1:8080`, preview on `4173` (`strictPort`); Vitest runs in jsdom with CSS processing disabled (`css: false`), so CSS-level regressions are asserted against the CSS source in `src/test/embedSizing.test.ts`.
- `tsconfig.json` / `tsconfig.app.json` / `tsconfig.node.json` — strict mode, no unused locals/parameters, ES2022.
- `eslint.config.js` — flat config; `src/test/*` gets the Vitest globals.
- `.prettierrc.json` — no semicolons, single quotes, print width 100.
- Design tokens live in `src/styles/tokens.css`; component styles are CSS Modules.

## Content model

All site content lives in `src/content/`:

- `site.ts` — brand name, tagline, support line, contract note, disclaimer, copyright, and the optional `play` section config for the practice arcade.
- `x.ts` — verified X posts as URL-only records (`{ id, url }`): `X_POSTS` (community quotes), `GALLERY_POSTS` (official account posts), and `FEATURED_X_POST`.
- `ecosystem.ts` — the two external discovery links plus their neutrality warning.

To reuse this starter, replace these files — and the metadata in `index.html` and
`package.json` — with your own verified content.

## Testnet deployment (46630)

The paid flow is fully wired for testnet: WalletConnect (project id +
per-chain `rpcMap` + app metadata via `VITE_*` env), env-driven contract
deployment with Blockscout verification (`contracts/.env.example`,
`npm --prefix contracts run deploy:testnet`), and an env-driven game server
(`apps/server/.env.example`). See the step-by-step runbook at
`.hermes/testnet-deployment-runbook.md` — official RPC/explorer endpoints and
keys are owner-supplied, never invented.

## FRONG Catch (practice arcade)

The demo ships a free practice mode of FRONG Catch embedded directly in the fan
page (`#play`) — no wallet, no payments, no prizes, consistent with the trust
boundaries above.

- **Simulation** — `src/game/sim/` is a pure, seeded, fixed-timestep state
  machine (60 ticks/s). The same seed + input log always replays to the same
  score (`replayGame`); golden values are pinned in `src/test/gameSim.test.ts`.
- **Renderer** — `src/game/render.ts` draws the pond on a canvas; all state
  lives in the DOM HUD for assistive tech. Cosmetic effects (splash, score
  floaters, ambience) are deterministic and disabled under reduced motion.
- **Screens** — attract (rules, fly legend, tiers, best score) → 3-2-1
  countdown → 60s run → results (tier, stats, share intent, play again).
- **Controls** — mouse / touch / ← → arrow keys; P or Esc pauses; auto-pause on
  blur/hidden tab.
- **Persistence** — best score only, in `localStorage` (`frong-catch-best-score`).
- **Rebranding** — the section is content-driven: omit `play` from the
  `SiteConfig` (or replace it) to ship a read-only fan page.

## Demo content & provenance

The FRONG demo content was verified against the live public URLs before inclusion
(oEmbed HTTP 200 for every post):

- **Featured from X** — <https://x.com/TradePools/status/2088370565644259531>
- **Wall of Love** — <https://x.com/TradePools/status/2088370565644259531> ·
  <https://x.com/saintniko/status/2088371383562850665> ·
  <https://x.com/ianheinischmma/status/2088370792132133293>
- **Gallery (official account)** — <https://x.com/frongcommunity/status/2088518209813029016> ·
  <https://x.com/frongcommunity/status/2087638804718829952> ·
  <https://x.com/frongcommunity/status/2087931863234904155>
- **Discovery links** — <https://pools.trade/t/0x6245e67affA44a23077f0Ea7f981a8DC743a0c47> ·
  <https://app.uniswap.org/>

Provenance rules (unchanged from the demo): official embeds only; attribution is
preserved through the embed itself; external links are discovery-only — not
sponsorship, endorsement, or financial advice.

## Trust boundaries

- Independent fan-made community media. Not affiliated with or endorsed by any token team, chain, or exchange.
- Not financial advice. Verify contracts and links yourself.
- The contract address is shown only as a neutral identification note (with a copy button).
- The embedded arcade never prompts for a wallet on its own: free practice stays
  walletless, and the only path to wallet connection, a verification signature,
  or the non-refundable FRONG entry fee is the player explicitly choosing the
  trophy run (with the fee disclosed before payment).

## License

MIT — see [LICENSE](LICENSE).
