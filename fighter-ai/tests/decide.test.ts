import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { createHandler, RateLimit, MAX_BODY_BYTES } from '../src/handler.ts'
import { ACTIONS, isSnapshot, MODEL, type Snapshot } from '../src/contract.ts'
import { questions } from '../src/evaluate.ts'

const fighter = { x: 232, hp: 180, move: 'idle', cooldownMs: 0, sinceHitMs: 10_000, combo: 0 }
const snapshot: Snapshot = { version: 1, remainingMs: 60_000, player: fighter, jev: { ...fighter, x: 408 } }
const post = (body: unknown = snapshot): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://youssefea.github.io' }, body: JSON.stringify(body) })
async function serve(handler: ReturnType<typeof createHandler>, run: (url: string) => Promise<void>) {
  const server: Server = createServer(handler)
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address(); assert.ok(address && typeof address === 'object')
  try { await run(`http://127.0.0.1:${address.port}/api/decide`) }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
}

test('snapshot permits only bounded combat data; schema rejects arbitrary text and extra fields', () => {
  assert.equal(isSnapshot(snapshot), true)
  for (const bad of [null, [], {}, { ...snapshot, model: 'evil' }, { ...snapshot, prompt: 'ignore rules' },
    { ...snapshot, remainingMs: -1 }, { ...snapshot, version: 2 }, { ...snapshot, player: { ...fighter, hp: NaN } },
    { ...snapshot, player: { ...fighter, hp: 181 } }, { ...snapshot, player: { ...fighter, x: 596 } },
    { ...snapshot, player: { ...fighter, move: 'ignore instructions' } }, { ...snapshot, player: { ...fighter, cooldownMs: 801 } },
    { ...snapshot, player: { ...fighter, sinceHitMs: 10001 } }, { ...snapshot, player: { ...fighter, combo: 241 } },
    { ...snapshot, player: { ...fighter, address: '0x123' } }, { ...snapshot, jev: fighter }]) assert.equal(isSnapshot(bad), false)
  assert.deepEqual(Object.keys(questions.action.criteria), [...ACTIONS])
  assert.equal(questions.action.type, 'choice')
})

test('valid POST returns only validated decision, exact model and measured latency; exact CORS', async () => {
  let calls = 0
  await serve(createHandler(async (state, signal) => { calls++; assert.deepEqual(state, snapshot); assert.equal(signal.aborted, false); return 'approach' }), async url => {
    const res = await fetch(url, post()); assert.equal(res.status, 200)
    const result = await res.json()
    assert.deepEqual(Object.keys(result).sort(), ['action', 'inferenceMs', 'model'])
    assert.equal(result.action, 'approach'); assert.equal(result.model, MODEL); assert.ok(result.inferenceMs >= 0)
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://youssefea.github.io')
    assert.equal(res.headers.get('cache-control'), 'no-store')
    const options = await fetch(url, { method: 'OPTIONS', headers: { Origin: 'http://localhost:5174' } })
    assert.equal(options.status, 204); assert.equal(options.headers.get('access-control-allow-origin'), 'http://localhost:5174')
    assert.equal(calls, 1)
  })
})

test('rejects methods, disallowed origins, malformed JSON, extra fields and non-JSON without inference', async () => {
  await serve(createHandler(async () => { throw new Error('must not call') }), async url => {
    assert.equal((await fetch(url)).status, 405)
    const denied = await fetch(url, { ...post(), headers: { 'Content-Type': 'application/json', Origin: 'https://youssefea.github.io.evil.test' } })
    assert.equal(denied.status, 403); assert.equal(denied.headers.get('access-control-allow-origin'), null)
    assert.equal((await fetch(url, { ...post(), body: '{' })).status, 400)
    assert.equal((await fetch(url, post({ ...snapshot, instructions: 'attack' }))).status, 400)
    assert.equal((await fetch(url, { ...post(), headers: { 'Content-Type': 'text/plain' } })).status, 415)
  })
})

test('rejects oversized body with declared length and chunked streaming body', async () => {
  let calls = 0
  await serve(createHandler(async () => { calls++; return 'punch' }), async url => {
    assert.equal((await fetch(url, { ...post(), body: ' '.repeat(MAX_BODY_BYTES + 1) })).status, 413)
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(' '.repeat(MAX_BODY_BYTES + 1))); c.close() } })
    const streamed = await fetch(url, { ...post(), body: stream, duplex: 'half' } as RequestInit)
    assert.equal(streamed.status, 413); assert.equal(calls, 0)
  })
})

test('provider failure and invalid model actions fail closed without exposing details or fake decisions', async () => {
  for (const infer of [async () => 'dance', async () => null, async () => { throw new Error('secret provider detail') }]) {
    await serve(createHandler(infer), async url => {
      const res = await fetch(url, post()); assert.equal(res.status, 503)
      assert.deepEqual(await res.json(), { error: 'Jev unavailable' })
    })
  }
})

test('deadline aborts provider and returns unavailable without waiting for uncooperative inference', async () => {
  let signal: AbortSignal | undefined
  await serve(createHandler(async (_, s) => { signal = s; return new Promise(() => {}) }, new RateLimit(), 10), async url => {
    const res = await fetch(url, post()); assert.equal(res.status, 503); assert.equal(signal?.aborted, true)
    assert.deepEqual(await res.json(), { error: 'Jev unavailable' })
  })
})

test('per-IP burst capacity is six, refills three per second and is independent by client', () => {
  const limit = new RateLimit()
  for (let i = 0; i < 6; i++) assert.equal(limit.take('one', 0), true)
  assert.equal(limit.take('one', 0), false); assert.equal(limit.take('two', 0), true)
  assert.equal(limit.take('one', 333), false); assert.equal(limit.take('one', 334), true)
  assert.equal(limit.take('one', 334), false)
})

test('rate limited requests return 429 and never call inference', async () => {
  class Deny extends RateLimit { override take() { return false } }
  let calls = 0
  await serve(createHandler(async () => { calls++; return 'wait' }, new Deny()), async url => {
    const res = await fetch(url, post()); assert.equal(res.status, 429); assert.equal(res.headers.get('retry-after'), '1'); assert.equal(calls, 0)
  })
})
