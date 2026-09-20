import test from 'node:test'
import assert from 'node:assert/strict'
import { Combat, emptyInput } from '../src/combat.ts'
import { ACTIONS, ACTION_TTL_MS, CADENCE_MS, MAX_SNAPSHOT_AGE_MS, JEV_MODEL, JevController, combatSnapshot, decisionInput, parseDecision, requestDecision, type Decision, type Snapshot } from '../src/jev.ts'
import { isSnapshot } from '../../fighter-ai/src/contract.ts'

const result = (action: Decision['action'] = 'kick'): Decision => ({ action, model: JEV_MODEL, inferenceMs: 12 })
const flush = async () => { await Promise.resolve(); await Promise.resolve() }
function harness() {
  let now = 0
  const requests: { snapshot: Snapshot; signal: AbortSignal; resolve: (v: Decision) => void; reject: (e: Error) => void }[] = []
  const game = new Combat(() => .5); game.countdown = 0
  const controller = new JevController((snapshot, signal) => new Promise((resolve, reject) => requests.push({ snapshot, signal, resolve, reject })), () => now)
  return { controller, requests, game, time: (value: number) => { now = value }, tick: (enabled = true) => controller.tick(enabled, () => combatSnapshot(game)) }
}

test('all model actions map to explicit deterministic controls, with no input after TTL or missing decision', () => {
  for (const action of ACTIONS) {
    const decision = { ...result(action), expiresAt: 100, roundTripMs: 10 }
    const expected = emptyInput()
    if (action === 'punch' || action === 'kick' || action === 'block') expected[action] = true
    if (action === 'approach') expected.left = true
    if (action === 'retreat') expected.right = true
    assert.deepEqual(decisionInput(decision, 99, 200, 300), expected)
    assert.deepEqual(decisionInput(decision, 100, 200, 300), emptyInput())
  }
  assert.deepEqual(decisionInput(null, 0, 200, 300), emptyInput())
  assert.equal(decisionInput({ ...result('approach'), expiresAt: 100, roundTripMs: 10 }, 0, 300, 200).right, true)
})

test('combat snapshots conform to backend numeric schema and contain no wallet/network data', () => {
  const g = new Combat(() => .5)
  g.fighters.bot.nextAttack = 799.8; g.fighters.player.x = 232.3
  assert.equal(isSnapshot(combatSnapshot(g)), true)
  assert.deepEqual(Object.keys(combatSnapshot(g)), ['version', 'remainingMs', 'player', 'jev'])
  assert.deepEqual(Object.keys(combatSnapshot(g).jev), ['x', 'hp', 'move', 'cooldownMs', 'sinceHitMs', 'combo'])
  g.elapsed = 100_000; assert.equal(combatSnapshot(g).jev.sinceHitMs, 10_000)
})

test('one-in-flight and 450ms cadence use wall time; snapshot is captured at dispatch', async () => {
  const h = harness(); h.tick(); assert.equal(h.requests.length, 1)
  h.game.fighters.player.x = 250
  h.time(100); h.tick(); h.tick(); assert.equal(h.requests.length, 1)
  assert.equal(h.requests[0].snapshot.player.x, 232)
  h.requests[0].resolve(result()); await flush()
  assert.equal(h.controller.view.status, 'live'); assert.equal(h.controller.view.action, 'kick')
  assert.deepEqual(h.controller.view.metrics, { inferenceMs: 12, roundTripMs: 100 })
  h.time(CADENCE_MS - 1); h.tick(); assert.equal(h.requests.length, 1)
  h.time(CADENCE_MS); h.tick(); assert.equal(h.requests.length, 2)
  assert.equal(h.requests[1].snapshot.player.x, 250)
  h.time(1_000); h.tick(); assert.equal(h.requests.length, 2, 'never overlap a slow request')
  assert.equal(h.game.elapsed, 0, 'scheduler is independent of frozen combat')
})

test('TTL expiration clears held input and waits without scripted fallback; waiting still schedules', async () => {
  const h = harness(); h.tick(); h.requests[0].resolve(result('block')); await flush()
  assert.equal(h.controller.input(200, 300).block, true)
  h.time(ACTION_TTL_MS); assert.equal(h.controller.view.status, 'waiting'); assert.equal(h.controller.view.action, null)
  assert.deepEqual(h.controller.input(200, 300), emptyInput())
  h.tick(); assert.equal(h.requests.length, 2)
})

test('pause aborts request, ignores even an abort-insensitive late result; resume reacquires fresh state', async () => {
  const h = harness(); h.tick(); h.tick(false)
  assert.equal(h.requests[0].signal.aborted, true); assert.equal(h.controller.view.status, 'paused')
  h.time(500); h.tick(false); assert.equal(h.requests.length, 1)
  h.requests[0].resolve(result()); await flush()
  assert.equal(h.controller.view.action, null)
  h.tick(); assert.equal(h.requests.length, 2); assert.equal(h.controller.view.status, 'waiting')
  h.requests[1].resolve(result('approach')); await flush(); assert.equal(h.controller.view.action, 'approach')
})

test('old-round responses cannot cross a reset, including reset plus resume before response', async () => {
  const h = harness(); h.tick(); h.controller.reset(); h.tick()
  assert.equal(h.requests.length, 1, 'await aborted request settlement before sending another')
  h.requests[0].resolve(result('punch')); await flush()
  assert.equal(h.controller.view.action, null); assert.equal(h.controller.view.metrics, null)
  h.tick(); assert.equal(h.requests.length, 2)
  h.requests[1].resolve(result('retreat')); await flush(); assert.equal(h.controller.view.action, 'retreat')
})

test('stale snapshot response fails closed even when request succeeded; error backs off then recovers', async () => {
  const h = harness(); h.tick(); h.time(MAX_SNAPSHOT_AGE_MS)
  h.requests[0].resolve(result()); await flush()
  assert.equal(h.controller.view.status, 'unavailable'); assert.deepEqual(h.controller.input(200, 300), emptyInput())
  h.tick(); assert.equal(h.requests.length, 1)
  h.time(MAX_SNAPSHOT_AGE_MS + 1_000); h.tick(); assert.equal(h.requests.length, 2)
  h.requests[1].resolve(result('wait')); await flush(); assert.equal(h.controller.view.status, 'live')
})

test('provider failures clear previous actions immediately; dispose aborts and prevents future requests', async () => {
  const h = harness(); h.tick(); h.requests[0].resolve(result('punch')); await flush()
  h.time(CADENCE_MS); h.tick(); h.requests[1].reject(new Error('unavailable')); await flush()
  assert.equal(h.controller.view.status, 'unavailable'); assert.equal(h.controller.view.action, null)
  h.time(2_000); h.tick(); assert.equal(h.requests.length, 3)
  h.controller.dispose(); assert.equal(h.requests[2].signal.aborted, true)
  h.requests[2].resolve(result()); await flush(); h.time(5_000); h.tick()
  assert.equal(h.requests.length, 3); assert.equal(h.controller.view.action, null)
})

test('request transport sends only snapshot with no credentials; non-OK or malformed output never produces action', async () => {
  const snapshot = combatSnapshot(new Combat())
  const signal = new AbortController().signal
  const request = requestDecision('https://example.test/api/decide', (async (url, options) => {
    assert.equal(url, 'https://example.test/api/decide'); assert.equal(options?.method, 'POST')
    assert.equal(options?.credentials, 'omit'); assert.deepEqual(JSON.parse(options!.body as string), snapshot)
    return Response.json(result())
  }) as typeof fetch)
  assert.deepEqual(await request(snapshot, signal), result())
  for (const response of [new Response('offline', { status: 503 }), Response.json({ action: 'dance' }), new Response('{')]) {
    await assert.rejects(requestDecision('url', (async () => response) as typeof fetch)(snapshot, signal))
  }
  for (const value of [null, { ...result(), model: 'typesafe-ai/jev-latest' }, { ...result(), action: 'dance' }, { ...result(), inferenceMs: NaN }, { ...result(), inferenceMs: -1 }, { ...result(), inferenceMs: 3_000 }]) assert.throws(() => parseDecision(value))
})
