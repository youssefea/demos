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

1. **Set up test accounts** explicitly creates three memory-only smart accounts: you, Jev, and the pot. All receive faucet test gas; only you and Jev receive faucet USDV. Zero-value token self-transfers deploy the accounts without funding the pot. Five sequential faucet drips can take a minute or longer. Retrying setup keeps the same accounts and signed deployment bytes.
2. **Start a $1 test round** calls the real `typesafe-ai/jev` evaluation model through Vercel AI SDK `experimental_evaluate`. The model sees at most 32 recent Coinbase trade prices/timestamps, never your pick or wallet information. There is no scripted fallback. Jev's decision is based on recent history, before the eventual baseline is known.
3. After Jev replies, you have **one second to choose Up or Down**. Its choice is hidden in the UI until yours locks. The first valid click locks immediately; a missed deadline sends no stakes. Buttons are keyboard/touch accessible. This is a rapid demo, not an accessible extended-time betting mode.
4. Both accounts submit independent **1,000,000-base-unit** transfers to the pot. There is no price window until both receipts prove the exact transfers. Matching picks still make both stake transfers and then refund each one.
5. For opposite picks, take the first fresh trade whose exchange timestamp and browser receipt are both at or after funding completion. Its **source timestamp** is the baseline. The target is exactly baseline + 1,000ms. Use the **first accepted trade at or after target**, no later than **target +250ms**. Show the actual start/end prices; the observed horizon is therefore **1.00–1.25 seconds**, not an exact microsecond oracle.
6. Higher end price means Up wins, lower means Down wins, identical means refund. The pot submits either one 2-USDV payout or two 1-USDV refunds. A new round requires complete settlement and an empty pot. At most **20 starts per page**, including canceled/no-pick rounds; no automatic refill or autoplay.

### Fail-closed market feed

The browser uses public `wss://ws-feed.exchange.coinbase.com`, channel `ticker`, product `BTC-USD`. Price strings must be positive finite values with at most eight decimal places. Exchange timestamps must be no older than **750ms**, no more than **250ms ahead** of local time; trade IDs and source timestamps must increase. Duplicate/unordered trades are ignored. History is limited to 32 ticks / 30 seconds. The API independently validates bounds, monotonic time and a latest tick no older than one second.

Disconnects, stale prices, a **>750ms source or receipt gap**, hidden tabs, **>400ms scheduler delays**, or a wall/monotonic clock disagreement greater than 250ms void an unfinished price round. No qualifying endpoint means refund, not a later opportunistic price. Sparse markets or skewed device clocks can cause frequent voids; there is no REST/simulated-price fallback. A fixed result already in settlement is not changed by hiding the tab. The public feed is a reference exchange, not an onchain oracle.

**One second is the prediction horizon, not end-to-end confirmation time.** AI inference, human choice, stake confirmation, baseline acquisition and payout confirmation are separate. The UI reports server-observed AI inference and client-observed signing-to-verified-receipt latency, not guaranteed 200ms inclusion or finality.

## Test-money custody and settlement safety

**This is trusted browser-controlled test escrow, not a trustless betting protocol.** All three signers live in the same browser. Jev chooses a direction but has no autonomous custody. A user can inspect its hidden choice or modify client code; the hiding is UX, not a cryptographic commitment. There is no independent operator, escrow smart contract, authenticated price attestation, or enforceable fair-play security. Never use this design with real funds.

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

The Playwright smoke **mocks** the price socket, model response, and setup/network module boundaries for full UI payout/refund coverage; it also checks the real setup error path against deliberately unavailable RPC. It is **not evidence of live model calls or settlement**. It tests 1440px/390px layouts and saves `/tmp/one-second-{width}.png`. The smoke requires Vite dev source routes, not a built preview. Unit tests cover no-pick deadlines, stale/gapped prices, partial funding, unknown/late receipts, refunds, net payout, deduplication, and spending caps. `fighter-ai/tests/predict.test.ts` covers schema/CORS/body/method/rate limits, timeout and provider failure.

Before publishing, independently run one live funded browser session, inspect both stake transactions and payout/refunds in the explorer, and test feed interruption with pending funding. Do not consume the faucet concurrently from several browser tests. Build output includes the existing vendored AA bundle (~590 kB minified); its chunk-size warning is expected.
