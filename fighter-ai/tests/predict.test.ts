import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createPredictionHandler, predictionQuestions } from '../src/predict.ts'
import { isPredictionSnapshot, OBSERVATION_MAX_AGE, PREDICTION_MODEL } from '../src/prediction-contract.ts'
import { RateLimit } from '../src/handler.ts'
const snapshot = (now = Date.now()) => ({ version: 1, ticks: [{ price: 65000.01, time: now - 300 }, { price: 65000.02, time: now }] })
const post = (body: unknown = snapshot()): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://youssefea.github.io' }, body: JSON.stringify(body) })
async function serve(handler: ReturnType<typeof createPredictionHandler>, run: (url: string) => Promise<void>) {
  const server = createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address(); assert.ok(address && typeof address === 'object')
  try { await run(`http://127.0.0.1:${address.port}/api/predict`) }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
}
test('bounded price-only schema rejects picks, text, stale/unordered/future ticks and excessive history', () => {
  const now = Date.now(), valid = snapshot(now)
  assert.equal(isPredictionSnapshot(valid, now), true)
  for (const bad of [null, {}, { ...valid, pick: 'up' }, { ...valid, address: '0x123' }, { ...valid, ticks: [] }, { ...valid, ticks: Array(33).fill(valid.ticks[0]) }, { ...valid, ticks: [valid.ticks[1], valid.ticks[0]] }, snapshot(now - OBSERVATION_MAX_AGE - 1), snapshot(now + 251), { ...valid, ticks: [{ price: NaN, time: now - 500 }, valid.ticks[1]] }, { ...valid, ticks: [{ price: 1, time: now - 31_000 }, valid.ticks[1]] }, { ...valid, ticks: [{ ...valid.ticks[0], prompt: 'up' }, valid.ticks[1]] }]) assert.equal(isPredictionSnapshot(bad, now), false)
  assert.deepEqual(Object.keys(predictionQuestions.direction.criteria), ['up', 'down'])
})
test('heartbeat-confirmed carry-forward observations are valid without inventing a new trade', () => {
  const now = Date.now()
  const quiet = { version: 1, ticks: [{ price: 65000, time: now - 2000 }, { price: 65000, time: now - 1001 }] }
  assert.equal(isPredictionSnapshot(quiet, now), true)
  assert.equal(isPredictionSnapshot(snapshot(now - OBSERVATION_MAX_AGE), now), true)
  assert.match(predictionQuestions.direction.instructions, /heartbeats carrying forward the actual last-trade price/)
})
test('actual adapter contract, model and allowed CORS are exact; input has no human pick', async () => {
  await serve(createPredictionHandler(async state => { assert.deepEqual(Object.keys(state).sort(), ['ticks', 'version']); return 'up' }), async url => {
    const res = await fetch(url, post()); assert.equal(res.status, 200)
    const body = await res.json(); assert.equal(body.pick, 'up'); assert.equal(body.model, PREDICTION_MODEL); assert.ok(body.inferenceMs >= 0)
    assert.deepEqual(Object.keys(body).sort(), ['inferenceMs', 'model', 'pick'])
    for (const origin of ['http://localhost:5175', 'http://localhost:4173', 'https://youssefea.github.io']) {
      const options = await fetch(url, { method: 'OPTIONS', headers: { Origin: origin } })
      assert.equal(options.status, 204); assert.equal(options.headers.get('access-control-allow-origin'), origin)
    }
  })
})
test('invalid inputs, methods, origins, body size and content type do not reach inference', async () => {
  let calls = 0
  await serve(createPredictionHandler(async () => { calls++; return 'down' }), async url => {
    assert.equal((await fetch(url)).status, 405)
    assert.equal((await fetch(url, { ...post(), headers: { Origin: 'https://evil.test', 'Content-Type': 'application/json' } })).status, 403)
    assert.equal((await fetch(url, post({ ...snapshot(), human: 'up' }))).status, 400)
    assert.equal((await fetch(url, { ...post(), body: '{' })).status, 400)
    assert.equal((await fetch(url, { ...post(), body: ' '.repeat(2049) })).status, 413)
    assert.equal((await fetch(url, { ...post(), headers: { 'Content-Type': 'text/plain' } })).status, 415)
    assert.equal(calls, 0)
  })
})
test('timeout cancels model, invalid response/provider failure never fabricate a pick', async () => {
  for (const infer of [async () => 'flat', async () => { throw new Error('provider secret') }]) {
    await serve(createPredictionHandler(infer), async url => { const res = await fetch(url, post()); assert.equal(res.status, 503); assert.deepEqual(await res.json(), { error: 'Jev unavailable' }) })
  }
  let signal: AbortSignal | undefined
  await serve(createPredictionHandler(async (_, s) => { signal = s; return new Promise(() => {}) }, new RateLimit(), 10), async url => {
    const res = await fetch(url, post()); assert.equal(res.status, 503); assert.equal(signal?.aborted, true)
  })
})
test('rate limit refuses inference', async () => {
  class Deny extends RateLimit { override take() { return false } }
  await serve(createPredictionHandler(async () => { throw new Error('must not call') }, new Deny()), async url => assert.equal((await fetch(url, post())).status, 429))
})
