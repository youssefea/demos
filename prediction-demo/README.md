# ONE SECOND — you vs Jev

A Bitcoin **Up / Down** prediction demo on **Base Vibenet (84538453)**. [Play the demo](https://youssefea.github.io/demos/predict/).

Two independent picks, two actual native-AA stakes of **1 test USDV**, one short BTC price window. The winner receives the **2-USDV pot**, a net gain of 1. Matching picks, unchanged price, or invalid market timing return the stakes. No real money, wallet extension, personal wallet access, or autoplay.

## Run

Node 22+ and npm. Keep this folder alongside `200ms-demo`, `fighter-demo`, and `fighter-ai`; the existing vendored `@vibenet/aa` and chain helpers are shared without changing the original apps.

```sh
cd prediction-demo
npm ci
npm run dev                 # http://localhost:5175
npm test
npm run build -- --base=/demos/predict/
npm run preview -- --base=/demos/predict/ # http://localhost:4173/demos/predict/
```

The public API URL defaults to `https://block-fighter-jev.vercel.app/api/predict`. Override **only the URL** with `VITE_PREDICTION_API_URL`. Never put provider credentials in frontend environment variables. Deploy `fighter-ai` separately to Vercel using its existing AI Gateway configuration. `/api/decide` and the old fighter remain intact.

The single repository Pages workflow tests/builds all three apps and publishes `/demos/200ms/`, `/demos/fighter/`, and `/demos/predict/`. It does not deploy the Vercel API. The optional repository Actions variable `VITE_PREDICTION_API_URL` selects another endpoint.

## Round rules and timing

1. **Landing on the page automatically funds and deploys** three memory-only smart accounts: you, Jev, and the pot. The faucet sends one 0.1-test-ETH gas drip to your disposable wallet and two USDV drips (you and Jev); after your wallet deploys, it sends one confirmed native-ETH batch that gives Jev and the pot up to 0.02 test ETH each. This replaces two faucet gas drips and their cooldowns. Balances are read from the chain, not assumed. Zero-value token self-transfers deploy the accounts without funding the pot with USDV. Retrying setup keeps the same accounts and identical signed deployment/distribution bytes, and React rerenders/effect replay share one setup run rather than funding twice.
2. **Tap Up or Down** to place a 1-USDV test bet. There is no setup/start/confirm button in the normal flow and no separate deadline to click. The direction tap calls the real `typesafe-ai/jev` evaluation model through Vercel AI SDK `experimental_evaluate`. The model sees at most 32 recent Coinbase last-trade price observations/timestamps (trades and verified heartbeats), never your pick or wallet information. There is no scripted fallback.
3. When Jev replies, the already-selected human direction and Jev's independent choice lock, and both stakes submit automatically. Repeated taps cannot create overlapping rounds. Outages, hidden tabs or stale input before inference completes place no bet. Merely visiting or waiting on the page never places a bet or calls the model.
4. Both accounts submit independent **1,000,000-base-unit** transfers to the pot. There is no price window until both receipts prove the exact transfers. Matching picks still make both stake transfers and then refund each one.
5. For opposite picks, take the first coverage-verified exchange heartbeat whose source timestamp and browser receipt are both at or after funding completion. Its actual last-trade price is the baseline, including in a quiet market. The cutoff is **exactly baseline source timestamp + 1,000ms**. Use the latest actual trade **at or before the cutoff** (carry forward the baseline if none). A heartbeat at or after cutoff must confirm complete trade-ID coverage before deciding the result. A trade after cutoff never affects the outcome. Exchange microseconds are preserved internally, including ordered trades within the same millisecond. The one-second countdown may briefly finish with **Checking result…** while awaiting proof.
6. Higher end price means Up wins, lower means Down wins, identical means refund. The pot submits either one 2-USDV payout or two 1-USDV refunds. Up/Down automatically become available again after complete settlement and an empty pot. At most **20 direction-tap starts per page**, including canceled attempts; no automatic refill or automatic wagers. The session-end reset appears only after settlement.

### Loading screen

The game stays unmounted behind a full-page loading screen until funding, wallet deployment, gas redistribution, and final balance checks succeed. The BTC market subscription and round timer also start only after setup succeeds. Setup events drive five real stages: network checks, account creation/recovery, three faucet checks, three deployments plus one confirmed gas-distribution batch, and final balances. Stage completion is never driven by a cosmetic timer.

The loading screen shows playful stage names, the current operation, and a rough time-left range. Funding estimates use the faucet's advertised cooldown plus RPC/deployment allowances; they update as work finishes. They are not guarantees: once the estimate is exhausted, the screen says it is taking longer instead of showing zero seconds or pretending to finish. Errors keep the game hidden and expose Retry, reusing the same prepared accounts and deployment bytes. Reduced-motion preference disables the spinner.

### Fail-closed market feed

The browser uses public `wss://ws-feed.exchange.coinbase.com`, channels **`matches` and `heartbeat`**, product `BTC-USD`. Unlike batched ticker updates, matches exposes individual trades. The initial `last_match` may be old; a current heartbeat must agree with its trade ID before the feed is ready. Subsequent trade IDs must be contiguous and trade timestamps nondecreasing; ordered same-millisecond trades are accepted. Duplicate/older-ID frames and old heartbeats are ignored. Each accepted heartbeat must name exactly the latest received trade ID. A missing trade, mismatched heartbeat, invalid frame, or disconnect invalidates coverage and reconnects/resyncs for future rounds. Genuine missing messages refund an active unfinished round; there is no REST repair or simulated-price fallback.

**Trade inactivity is not feed interruption.** Heartbeats approximately every second carry forward the actual last traded price at exchange observation time, not a fabricated price or a claimed new trade. Two heartbeats suffice for model input even if no new trade occurs. Chart/model history is bounded to 32 observations / 30 seconds, coalescing same-millisecond observations; the active round separately retains its last pre-cutoff trade in constant memory so bursts cannot evict the outcome. API v1 remains strictly price/time-only; it independently validates bounds, monotonic millisecond observation time, and latest observation no older than **3.5 seconds**. Model instructions explain carried-forward observations. Exchange times may be up to **250ms ahead** of local time.

A missing heartbeat for **3.5 seconds**, lost coverage, hidden tab, or wall/monotonic clock disagreement greater than 250ms voids an unfinished round. Baseline/cutoff proof waits are additionally capped at **4 seconds**; ordinary scheduling delays alone do not void a timestamp-proven result. There is no requirement for a trade at the endpoint or within 750ms. All refunds still wait for funding to resolve; unknown stakes never trigger speculative transfers. A fixed result already in settlement is not changed by feed loss or hiding the tab. The public feed is a reference exchange, not an authenticated/onchain oracle.

**One second is the prediction horizon, not end-to-end confirmation time.** Human choice, AI inference, stake confirmation, baseline acquisition and payout confirmation are separate. The compact feed reports client-observed signing-to-verified-receipt latency, not guaranteed 200ms inclusion or finality. Rules, account addresses and full transfer history are collapsed under Details.

## Test-money custody and settlement safety

**This is trusted browser-controlled test escrow, not a trustless betting protocol.** All three signers live in the same browser. Jev chooses a direction but has no autonomous custody. Users can modify client code; there is no independent operator, escrow smart contract, authenticated price attestation, or enforceable fair-play security. Never use this design with real funds.

- Only Vibenet chain 84538453 is accepted during setup; live account/token addresses and bytecode are discovered and verified. Keys are never stored, logged, or sent to Jev. **Reloading discards keys and history. Do not close/reload while funds are in the pot or a transfer is unresolved.** A browser unload warning is best effort, not recovery.
- Every round transaction uses EIP-8130 native account abstraction, `nonceKeyMax`, a 15-second millisecond `validBefore`, and unique session/round/ordinal metadata. Hash and expected transfer are registered **before broadcast**. Retries reuse identical signed bytes, at most four broadcast attempts before expiry; RPC errors never create replacement payments.
- One persistent chain WebSocket tracks heads and transfer notifications; HTTP receipt reconciliation also runs. Notifications trigger receipt checks; they do not independently credit balances. Confirmation requires a successful outer receipt and exactly one explicitly successful AA phase, plus the exact hash, USDV contract, Transfer signature, from, to, amount, and mined/non-removed log. Duplicate delivery cannot double credit. Missing, empty, malformed or unsupported phase metadata stays unknown; only an explicit outer revert or the expected single reverted phase proves failure.
- Only verified receipts change displayed balances. Pending/unknown debits reserve funds. After 25 seconds without proof a transaction is **unknown**, not failed; reconciliation continues and no new round can start. Expiry alone is not proof of non-inclusion. **Recheck original receipts** only checks the original hashes.
- A partial stake failure refunds only confirmed contributions, and only after all stakes have resolved. Unknown funding blocks refunds until it resolves. A definitively failed payout/refund blocks the session with funds possibly left in the pot; no replacement is silently signed. This intentionally prioritizes non-duplication over recovery in a disposable test demo.
- Detected chain resets stop signing/reconciliation against old accounts. Reorganizations are not rolled back in the displayed ledger; this is observed inclusion, not finality. A devnet reset may erase all funds/history. Network outages, faucet cooldowns, gas exhaustion, API credits and provider availability remain external dependencies.

## Validation

```sh
npm test                    # deterministic price/round/ledger tests, no faucet
npm run build
# In another terminal keep npm run dev running:
npx playwright install chromium
npm run test:browser
# Optional system browser:
CHROME_EXECUTABLE_PATH=/path/to/chromium npm run test:browser
```

The Playwright smoke **mocks** the price socket, model response, and setup/network boundaries. It verifies automatic setup/retry (zero market sockets before setup success), one-tap bets, next-round readiness, no idle model/wager loop, payout/same-pick/quiet-market flat refunds, provider outage, and compact above-the-fold controls at 1440px/390px. Screenshots: `/tmp/one-second-simple-{width}.png`. It is **not evidence of live model calls or settlement**. The smoke requires Vite dev source routes. Unit tests additionally cover repeated taps, hidden-tab/clock-jump cancellation, quiet heartbeat-only markets, exact cutoff and sub-millisecond exclusion, rapid bursts, actual missing IDs/mismatched heartbeats, bounded proof waits, reconnect/resync, partial funding, unknown/late receipts, refunds, net payout, deduplication, and spending caps. `fighter-ai/tests/predict.test.ts` covers schema/CORS/body/method/rate limits, timeout and provider failure.

Before publishing, independently run one live funded browser session, inspect both stake transactions and payout/refunds in the explorer, and test feed interruption with pending funding. Do not consume the faucet concurrently from several browser tests. Build output includes the existing vendored AA bundle (~590 kB minified); its chunk-size warning is expected.
