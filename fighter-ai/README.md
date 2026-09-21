# Jev decision API — fighter and ONE SECOND

A separate, API-only Vercel project for the GitHub Pages [fighter](../fighter-demo/). Uses **Vercel AI SDK `experimental_evaluate`** with **TypeSafe AI `typesafe-ai/jev`**, an evaluation/decision model, not a chat model or scripted opponent. `ai@7.0.107` and `@ai-sdk/gateway@4.0.87` are pinned because this API is experimental. Verify SDK types and re-run tests before upgrading.

## Setup and deployment

Node 22+; no dependencies on sibling demos at runtime. The Vercel project is `block-fighter-jev` under personal scope `my-team-fe629064` (not an organization). Deploy **this directory only**, with framework preset **Other**, output directory `public` (configured in `vercel.json`), and OIDC enabled. The public directory contains only a small API information page; Vercel compiles `api/decide.ts` and `api/predict.ts` separately as functions. The frontend stays on GitHub Pages; neither this API nor server dependencies are included in the Pages artifact.

```sh
cd fighter-ai
npm ci
npm test
npm run build # strict TypeScript check; Vercel compiles api/decide.ts

# Authenticated Vercel CLI; no token or API key in the command:
vercel link --yes --project block-fighter-jev --scope my-team-fe629064
vercel deploy --prod --yes --scope my-team-fe629064
```

Production endpoint: **https://block-fighter-jev.vercel.app/api/decide**. For a different backend address, set `VITE_JEV_API_URL` when building `fighter-demo`; the Pages workflow accepts the repository Actions variable of the same name. The URL is public configuration, **never a secret**. The production alias must permit anonymous requests so browsers can play. Preview deployments may remain protected.

### Credentials

The gateway's default authentication uses Vercel OIDC when `AI_GATEWAY_API_KEY` is absent. Enable OIDC on the project and ensure AI Gateway is available to that Vercel account with credits/billing configured. No manually provisioned provider key is needed on the deployed path. Do not set any `VITE_*` credential, ship an OIDC token to the browser, or put credentials in source control.

For local API development, link the same project and use Vercel's local environment/OIDC support:

```sh
vercel env pull .env.local
vercel dev --listen 3000
# In another terminal, from fighter-demo:
VITE_JEV_API_URL=http://localhost:3000/api/decide npm run dev
```

A local OIDC token expires; refresh it with the Vercel CLI when needed. If your local CLI/environment cannot supply OIDC, a personal `AI_GATEWAY_API_KEY` may be configured **server-side only** in ignored `.env.local` as documented by AI Gateway. Never add it to frontend environment variables. Failed/missing credentials return `503`, not a fake action. Tests need no credentials, make no provider requests, and consume no faucet funds.

## Contract

`POST /api/decide`, `Content-Type: application/json`, maximum **2,048 bytes**. Example (contains no wallets, addresses or signed transactions):

```json
{
  "version": 1,
  "remainingMs": 60000,
  "player": { "x": 232, "hp": 180, "move": "idle", "cooldownMs": 0, "sinceHitMs": 10000, "combo": 0 },
  "jev": { "x": 408, "hp": 180, "move": "idle", "cooldownMs": 0, "sinceHitMs": 10000, "combo": 0 }
}
```

Coordinates are arena pixels (45–595), health is 0–180, cooldown is 0–800ms, combo is 0–240, remaining time is 0–60,000ms. All numbers must be finite integers. `sinceHitMs` is time since that fighter last **landed** a hit, capped at 10,000ms (also the no-hit sentinel). `move` is one of `idle`, `walk`, `punch`, `kick`, `block`, `hit`, `ko`. The human must be left of Jev. Extra keys and arbitrary text are rejected. Attack ranges, tactical instructions, model and choice criteria are server-owned constants.

A successful response contains only:

```json
{ "action": "approach", "model": "typesafe-ai/jev", "inferenceMs": 87 }
```

The action is one of `punch`, `kick`, `block`, `approach`, `retreat`, `wait`. The number above is illustrative, **not an inference result**. `inferenceMs` measures the actual elapsed SDK evaluation call, including gateway/provider transport, not isolated GPU compute. The browser separately measures round-trip latency. Neither is chain inclusion latency or the 200ms network target.

- `400`: malformed JSON or invalid schema; `413`: too large; `415`: wrong content type.
- `403`: disallowed supplied Origin; `405`: unsupported method (`OPTIONS` preflight is allowed).
- `429` with `Retry-After: 1`: per-instance IP rate limit.
- `503`: timeout, provider/credential failure or invalid model output. **No fallback decision.**
- Provider deadline **2 seconds**, `maxRetries: 0`, function `maxDuration: 5`. Disconnects abort the SDK call; cancellation cannot guarantee a provider has not already charged for work. Responses use `Cache-Control: no-store`.

## Bitcoin prediction endpoint

`POST /api/predict` powers [ONE SECOND](../prediction-demo/), without changing the fighter contract. It uses the same fixed Jev model, SDK evaluation API, body limit, timeout, no-retry policy, safe error responses and per-instance rate limiter. Browser origins are `https://youssefea.github.io`, `http://localhost:5175`, and `http://localhost:4173`.

The request is `{ "version": 1, "ticks": [{ "price": 65000.01, "time": 1234567890000 }, ...] }` (illustrative only; real requests need fresh timestamps). There must be 2–32 strictly time-ordered ticks, finite positive prices no greater than 10 million, safe-integer millisecond exchange timestamps within the last 30 seconds and at most 250ms in the future, and a latest timestamp no older than one second. Extra fields—including human picks, prompts, and wallet addresses—are rejected. The response is `{ "pick": "up", "model": "typesafe-ai/jev", "inferenceMs": 123 }`, with `pick` strictly `up` or `down`. The model does not see the human choice. Feed authenticity is not attested: these are bounded browser-supplied prices for a trusted-client test demo.

The endpoint is `https://block-fighter-jev.vercel.app/api/predict`; the frontend override is `VITE_PREDICTION_API_URL`. Deploy this API before publishing the new prediction frontend. For local testing, run `VITE_PREDICTION_API_URL=http://localhost:3000/api/predict npm run dev` from `prediction-demo` alongside `vercel dev` here.

## Public endpoint cost and abuse exposure

**This is a public, unauthenticated demo endpoint. CORS is not authentication.** Exact browser origins are `https://youssefea.github.io`, `http://localhost:5174` and `http://localhost:4173`; no wildcard or credentialed cookies. CORS origins have no path, so GitHub Pages permits that user's other pages as well. Non-browser clients can omit/spoof Origin. Nothing prevents arbitrary clients from submitting valid combat snapshots.

Best-effort in-memory per-IP token bucket: burst **6**, refill **3 requests/second**. The map is bounded at 10,000 clients and reclaims old entries under pressure. This limit resets on cold starts, is per function instance, not global, and does not stop distributed abuse or establish an identity. Shared IPs can experience throttling. Vercel's overwritten `x-vercel-forwarded-for` is used in deployment, and socket IP locally; never trust client `X-Forwarded-For` directly.

**Before exposing the demo, configure Vercel/AI Gateway spending budgets, alerts and available platform-level firewall/rate limits.** Monitor usage; disable access if necessary. Fixed small input, a fixed model, no retries and timeouts bound each call, not total cost across public traffic. Higher-assurance protection would require centralized rate limits/authentication; it is intentionally outside this small public demo.

## Validation

```sh
npm test
npm run build
```

Tests use an injected inference function and local HTTP server to cover successful responses, exact CORS, strict schema, malformed and oversized/chunked bodies, rate limiting, deadline cancellation, provider errors and invalid outputs. They are not evidence of live Jev availability. Production review must call the deployed endpoint with a valid snapshot and verify a real model response; the deployment maintainer owns that check.
