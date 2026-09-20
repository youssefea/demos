# BLOCK FIGHTER

A browser-only, original pixel-art player-vs-bot arcade fighter. **Each successful, unblocked hit submits one real transfer of 0.05 Vibenet test USDV (50,000 base units) from the fighter hit to the attacker.** Blocks and misses never transfer tokens. This is a devnet experiment, **not real money** and not a betting product.

## Run locally

Requires Node 22+ and npm. Keep this directory beside `200ms-demo/`: the AA SDK is a file dependency on its vendored bundle, and the fighter imports its existing chain configuration, live contract discovery, faucet queue and RPC helpers. The original streaming app is not modified.

```sh
cd fighter-demo
npm ci
npm run dev
# http://localhost:5174

npm test
npm run build
npm run preview
# http://localhost:4173
```

No environment variables, wallet extension, backend or external assets/fonts are needed. Nothing is funded, signed or broadcast before **Enter the arena**. That button creates **two separate memory-only smart accounts**, one for you and one for the bot, requests faucet gas and USDV for both, deploys both and calibrates gas. The setup deployment performs a one-base-unit **self-transfer**; it does not move money between fighters. The initial balances are read after funding. Click **Let's fight** to start the round.

The faucet currently rate-limits requests by IP/address. Four sequential drips can take a minute or longer. Progress identifies each funding step and the cooldown. On failure, **Retry setup** reuses the page's partially prepared accounts; it does not silently switch to fake transactions. Reloading creates fresh accounts and may hit another faucet cooldown.

## Controls

| Action | Keyboard | Touch / mouse |
| --- | --- | --- |
| Move | A / D or left / right arrows | Hold movement pads |
| Punch | Hold J (230ms cooldown) | Hold Punch |
| Kick | Hold K (300ms cooldown, longer reach) | Hold Kick |
| Block | Hold L | Hold Block |
| Pause | P / Escape | Pause button |
| Resume / rematch | Focus and activate the on-screen button | Tap the button |

Get close before attacking; punches have shorter reach than kicks. Health, a 60-second active-play timer, hit combos, animated attacks/blocks/KO, sparks and flying confirmation coins are rendered over a rooftop skyline. The bot approaches and sometimes blocks or retreats, but attacks less often than the player. Highest remaining health wins at time; a knockout ends the round early. A transfer-cap round also ends on health. Rematches require all outstanding transfers to resolve.

Losing browser focus, hiding the tab or moving focus outside the game cabinet pauses combat. Resume is explicit. Frame deltas are clamped: no background catch-up attacks. Already-submitted transactions may still confirm while paused. Keyboard focus remains visible; controls are real labeled buttons and work with Enter/Space. The high-frequency transaction feed is deliberately **not** a live screen-reader announcement region. Reduced-motion preference suppresses shake/drifting decoration. Sound is off by default and can be enabled manually.

## Real network, cautious accounting

- Network: **Base Vibenet, chain ID 84538453**, checked against the RPC and faucet.
- Live token/account discovery reuses `200ms-demo/src/chain/account.ts`, including the SDK's high-rate implementation fallback when the contracts API omits `eip8130`. Bytecode must exist.
- Each page/tab has its own two generated secp256k1 signers and smart accounts. Neither fighter can debit an arbitrary external wallet. Keys stay in memory, not in local/session storage, URLs or logs. **Never send real funds to these accounts. Keys are discarded on reload.**
- Account deployment and sequenced gas estimation follow the existing bootstrap. For hit transactions, gas is adjusted by `nonceFreeCost - nonceKeyExistingCost`, with a 30% margin, and fees refresh from live blocks.
- Every hit is signed with EIP-8130 `nonceKeyMax`, a 15-second `validBefore` in milliseconds, and unique session/ordinal/expiry metadata. Retries use **identical signed bytes**, never a new payment. Maximum four broadcast attempts, subject to expiry.
- Capacity is reserved synchronously before damage; signing counts toward the cap. The complete expected transaction hash is registered **before broadcasting**, so a log received before the RPC acknowledgement cannot be lost.
- One persistent WSS connection subscribes to both transfer directions and new heads, with bounded reconnect backoff. HTTP receipt reconciliation runs even if WSS looks healthy, recovering lost/out-of-order notifications.
- A confirmation requires the expected **hash + USDV contract + Transfer signature + victim/from + attacker/to + exact 50,000 amount + mined, non-removed log**. Receipt fallback additionally requires successful outer status and AA phase status. Duplicate notifications/receipts cannot double-credit.
- Gameplay balances and confirmed totals change **only** after that validated event. There is no optimistic debit, balance-delta inference, fake hash, simulated chain or simulated confirmation. Initial faucet balances are setup baselines. Combat damage is immediate, so a failed onchain submission can leave damage without a paid hit; the feed truthfully reports this rather than manufacturing a transaction.
- Local signing failures / reverted receipts are **failed**. Missing/ambiguous confirmations are **unknown** after a timeout (or immediately for a receipt without a validated transfer); funds stay unchanged and combat stops while reconciliation continues. An expired signature or HTTP error is **not** treated as proof that a transaction never landed. Late validated confirmations resolve unknowns. Recheck retries reconciliation, not another payment.
- Hard caps: **8 unresolved transfers**, **240 attempts / round (12.00 test USDV maximum transferred)**, **1,000 attempts / page session (50.00 test USDV)**. Failed attempts consume the attempt budget too. Pending victim debits reserve available token balance. Backpressure freezes combat/time and never queues catch-up hits. A stale head, detected devnet reset or missing funding stops new hits.
- The UI shows each direction, exact amount, lifecycle, explorer link, live head, confirmed total and **client-observed hit-to-confirm** latency (monotonic timestamp from hit reservation, including signing and transport). **200ms is a network target, not a guarantee**; this is observed inclusion, not a finality guarantee.

## Tests

```sh
npm test
# Deterministic combat + ledger/event validation tests, no network or faucet.

# Optional no-faucet browser smoke: keep npm run dev running in another terminal.
npx playwright install chromium
npm run test:browser
# Override URL or browser executable when desired:
FIGHTER_URL=http://localhost:5174 CHROME_EXECUTABLE_PATH=/path/to/chromium npm run test:browser
```

Unit coverage includes attack reach, blocked hits, cooldowns, bot payment direction, KO/time bounds, clamped background time, arena collision bounds, reservation/backpressure, exact event/receipt matching, pre-broadcast registration race, duplicate/out-of-order/bidirectional confirmations, reverted/missing-event/unknown paths, late confirmation, spend limits and balance conservation.

Browser smoke checks desktop (1440px) and mobile (390px), pixel rendering, no horizontal overflow, no prestart chain requests, a deliberately offline setup error and retry, and zero runtime errors. It saves screenshots to `/tmp/block-fighter-{width}.png`. **The browser smoke intentionally blocks the network; it is not proof of live settlement.** Independent live review should complete setup, hold J/K in range, allow bot hits, verify both directions in the explorer, disconnect WSS to exercise receipt fallback, and check blur/pause/rematch. Do not run multiple faucet-consuming tests concurrently on one IP.

## Publishing

The repository's **single** `.github/workflows/deploy-200ms-preview-pages.yml` builds/tests both apps, assembles one artifact, and preserves both routes:

- `/demos/200ms/` — original streaming demo
- `/demos/fighter/` — BLOCK FIGHTER

For an equivalent fighter production build: `npm run build -- --base=/demos/fighter/`. No competing Pages workflow or backend is introduced.

## Limitations

Vibenet is an ephemeral devnet: RPC/WSS downtime, faucet limits, resets, missing history and latency spikes are expected. The page detects stale/backward heads and periodically checks genesis; reset detection is not instantaneous. It does not promise finality or recover keys/history after a reload. Previously observed inclusion is not rolled back in the UI on a later chain reorganization; reload after a detected reset. Unknown transfers deliberately stop the fight rather than risk overspending. Accounts are not automatically refilled during matches; the 50-USDV session cap is below normal faucet funding. Gas exhaustion/rejection is reported, not subsidized by a backend. Browser keys are appropriate **only for disposable test funds**. The vendored SDK makes the initial JavaScript bundle relatively large (~600 kB uncompressed); there are no image/audio/font downloads.
