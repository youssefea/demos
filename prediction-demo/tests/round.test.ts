import test from 'node:test'
import assert from 'node:assert/strict'
import { Round, ROUND_LIMIT, type Inference, type Network } from '../src/round.ts'
import { Ledger, STAKE, type Transfer } from '../src/ledger.ts'
import { PriceBook, MAX_AGE, PROOF_WAIT } from '../src/price.ts'

function harness(infer: Inference = async () => ({ pick: 'down', inferenceMs: 100 })) {
  let now = 1_000_000, mono = now, visible = true, tradeId = 0
  const prices = new PriceBook(); prices.connected = true
  const ledger = new Ledger({ player: 20n * STAKE, jev: 20n * STAKE, pot: 0n })
  const net: Network = { ledger, blocked: null, send: (round, from, to, amount, label) => {
    const tx = ledger.create(round, from, to, amount, label, now)
    if (tx.status === 'signing') ledger.register(tx, `0x${tx.id.toString(16).padStart(64, '0')}`)
    return tx
  } }
  const round = new Round(net, prices, infer, () => now, () => mono, () => visible)
  const frame = (value: object) => {
    const tick = prices.add({ product_id: 'BTC-USD', time: new Date(now).toISOString(), ...value }, now)
    if (tick) round.onTick(tick); else round.advance()
    return tick
  }
  const tick = (price = 100, time = new Date(now).toISOString()) => frame({ type: tradeId ? 'match' : 'last_match', price: String(price), time, trade_id: ++tradeId })!
  const heartbeat = (last_trade_id = tradeId, time = new Date(now).toISOString()) => frame({ type: 'heartbeat', last_trade_id, time })
  const move = (ms: number) => { now += ms; mono += ms }
  tick(); heartbeat(); move(100); heartbeat()
  const pulse = (ms: number, price = 100, feed = true) => { for (let n = 0; n < ms; n += 50) { move(50); if (feed && n % 200 === 150) { tick(price); heartbeat() } round.advance() } }
  const confirm = (tx: Transfer) => ledger.confirm(tx, 100, now)
  const funded = async (pick: 'up' | 'down' = 'up') => { await round.start(); round.pick(pick); round.stakes.forEach(confirm); round.advance() }
  return { round, ledger, net, prices, tick, heartbeat, frame, move, pulse, confirm, funded, now: () => now, hide: () => { visible = false }, jump: (ms: number) => { now += ms; round.advance() } }
}
test('both stakes precede baseline; hidden Jev pick, fixed one-second horizon, winner gets exactly 2 USDV once', async () => {
  const h = harness(); await h.round.start()
  assert.equal(h.round.jev, undefined); assert.equal(h.round.phase, 'picking'); assert.equal(h.ledger.transfers.length, 0)
  h.round.pick('up'); assert.equal(h.round.jev, 'down'); assert.equal(h.round.phase, 'funding')
  h.confirm(h.round.stakes[0]); h.pulse(200); assert.equal(h.round.baseline, undefined)
  h.confirm(h.round.stakes[1]); h.round.advance(); const fundedAt = h.now()
  h.pulse(200); assert.ok(h.round.baseline!.time > fundedAt)
  const base = h.round.baseline!.time
  h.pulse(800, 101); assert.equal(h.round.end, undefined)
  h.pulse(200, 101); assert.equal(h.round.end!.time, base + 1000); assert.equal(h.round.result, 'player')
  assert.equal(h.round.payments.length, 1); assert.equal(h.round.payments[0].amount, 2n * STAKE)
  assert.equal(h.ledger.balances.player, 19n * STAKE)
  h.confirm(h.round.payments[0]); h.confirm(h.round.payments[0]); h.pulse(200)
  assert.equal(h.round.phase, 'done'); assert.equal(h.ledger.balances.player, 21n * STAKE)
  assert.equal(h.ledger.balances.jev, 19n * STAKE); assert.equal(h.ledger.balances.pot, 0n)
  assert.equal(h.ledger.transfers.length, 3)
})
test('same picks still submit both stakes and refund each contribution exactly once', async () => {
  const h = harness(); await h.funded('down')
  assert.equal(h.round.result, 'refund'); assert.equal(h.round.payments.length, 2)
  h.round.payments.forEach(h.confirm); h.pulse(200)
  assert.equal(h.round.phase, 'done'); assert.equal(h.ledger.transfers.length, 4)
  assert.equal(h.ledger.balances.player, 20n * STAKE); assert.equal(h.ledger.balances.jev, 20n * STAKE)
})
test('flat price refunds and opposite move pays Jev', async () => {
  for (const price of [100, 99]) {
    const h = harness(); await h.funded(); h.pulse(200); h.pulse(1000, price)
    assert.equal(h.round.result, price === 100 ? 'refund' : 'jev')
    assert.equal(h.round.payments.reduce((a, t) => a + t.amount, 0n), 2n * STAKE)
  }
})
test('UNKNOWN funding never triggers speculative refund; late confirmation refunds after abort', async () => {
  const h = harness(); await h.round.start(); h.round.pick('up')
  h.confirm(h.round.stakes[0]); h.round.stakes[1].status = 'unknown'
  h.round.abort('Feed disconnected'); h.pulse(3000)
  assert.equal(h.round.payments.length, 0); assert.equal(h.round.canStart, false); assert.equal(h.ledger.transfers.length, 2)
  h.confirm(h.round.stakes[1]); h.round.advance()
  assert.equal(h.round.payments.length, 2); assert.equal(h.round.result, 'refund')
  h.pulse(1000); assert.equal(h.ledger.transfers.length, 4)
})
test('one failed stake refunds only the confirmed contribution', async () => {
  const h = harness(); await h.round.start(); h.round.pick('up')
  h.confirm(h.round.stakes[0]); h.round.stakes[1].status = 'failed'; h.round.advance()
  assert.equal(h.round.payments.length, 1); assert.equal(h.round.payments[0].to, 'player')
  h.confirm(h.round.payments[0]); h.round.advance(); assert.equal(h.ledger.balances.pot, 0n)
})
test('unknown payout stays blocked without replacement; failed payout cannot open a new round', async () => {
  for (const status of ['unknown', 'failed'] as const) {
    const h = harness(); await h.funded(); h.pulse(200); h.pulse(1000, 101)
    h.round.payments[0].status = status; h.pulse(1000); await h.round.start()
    assert.equal(h.round.canStart, false); assert.equal(h.ledger.transfers.length, 3)
    assert.equal(h.round.phase, status === 'failed' ? 'blocked' : 'settling')
  }
})
test('missed pick, hidden tab, missing heartbeats, clock jumps fail closed without new stakes', async () => {
  for (const abort of [(h: ReturnType<typeof harness>) => h.pulse(1100), (h: ReturnType<typeof harness>) => { h.hide(); h.round.advance() }, (h: ReturnType<typeof harness>) => h.pulse(MAX_AGE + 100, 100, false), (h: ReturnType<typeof harness>) => h.jump(401)]) {
    const h = harness(); await h.round.start(); abort(h); h.round.pick('up')
    assert.equal(h.round.phase, 'done'); assert.equal(h.ledger.transfers.length, 0)
  }
})
test('price interruption after funding leads to refunds; settlement continues while hidden', async () => {
  const h = harness(); await h.funded(); h.pulse(200); h.hide(); h.round.advance()
  assert.equal(h.round.result, 'refund'); assert.equal(h.round.payments.length, 2)
  h.round.payments.forEach(h.confirm); h.round.advance(); assert.equal(h.round.phase, 'done')
})
test('no AI fallback; API input has only bounded ticks and never the human pick', async () => {
  let state: unknown
  const h = harness(async snapshot => { state = snapshot; throw new Error('offline') }); await h.round.start()
  assert.equal(h.round.phase, 'done'); assert.equal(h.round.jev, undefined); assert.equal(h.ledger.transfers.length, 0)
  assert.deepEqual(Object.keys(state as object).sort(), ['ticks', 'version'])
})
test('one in-flight round and 20-round page cap', async () => {
  const h = harness(); await h.round.start(); await h.round.start(); assert.equal(h.round.number, 1)
  h.round.abort('cancel')
  for (let i = 1; i < ROUND_LIMIT; i++) { await h.round.start(); h.round.abort('cancel') }
  assert.equal(h.round.number, ROUND_LIMIT); assert.equal(h.round.canStart, false)
  await h.round.start(); assert.equal(h.round.number, ROUND_LIMIT)
})
test('late inference from a canceled round cannot overwrite a newer round', async () => {
  const requests: { resolve: (answer: { pick: 'up' | 'down'; inferenceMs: number }) => void; reject: (error: Error) => void }[] = []
  const h = harness(() => new Promise((resolve, reject) => requests.push({ resolve, reject })))
  const old = h.round.start(); h.round.abort('cancel'); const current = h.round.start()
  requests[0].reject(new Error('late old rejection')); await old
  assert.equal(h.round.phase, 'thinking')
  requests[1].resolve({ pick: 'down', inferenceMs: 25 }); await current
  h.round.pick('up'); assert.equal(h.round.jev, 'down'); assert.equal(h.round.number, 2)
})
test('disconnect during pending stakes voids price round, but cannot cancel an established payout', async () => {
  const h = harness(); await h.round.start(); h.round.pick('up'); h.prices.connected = false; h.round.advance()
  assert.equal(h.round.payments.length, 0); h.round.stakes.forEach(h.confirm); h.round.advance()
  assert.equal(h.round.result, 'refund'); assert.equal(h.round.payments.length, 2)
  const winner = harness(); await winner.funded(); winner.pulse(200); winner.pulse(1000, 101)
  winner.prices.connected = false; winner.round.abort('disconnect'); winner.round.advance()
  assert.equal(winner.round.result, 'player'); assert.equal(winner.ledger.transfers.length, 3)
})
test('quiet market with 1s heartbeats, no new trades, and >400ms scheduling gaps is a genuine flat draw', async () => {
  const h = harness(); await h.funded()
  h.move(1000); h.heartbeat(); assert.equal(h.round.phase, 'watching')
  const baseline = h.round.baseline!
  h.move(1000); h.heartbeat()
  assert.equal(h.round.end!.sourceTime, baseline.sourceTime + 1_000_000)
  assert.equal(h.round.result, 'refund'); assert.match(h.round.reason, /^Price unchanged/)
  h.round.payments.forEach(h.confirm); h.round.advance()
  h.move(1000); h.heartbeat(); assert.equal(h.round.canStart, true)
})
test('move before cutoff pays correctly without endpoint trade; post-cutoff reversal is excluded', async () => {
  const h = harness(); await h.funded(); h.move(100); h.heartbeat()
  const baseline = h.round.baseline!
  h.move(150); h.tick(101) // Only in-window price change, no endpoint tick.
  h.move(851); h.tick(99) // 1ms after cutoff, more than 750ms since the last trade.
  assert.equal(h.round.result, undefined); assert.equal(h.round.reason, 'Checking result…')
  h.move(500); h.heartbeat()
  assert.equal(h.round.result, 'player'); assert.equal(h.round.end!.price, 101)
  assert.equal(h.round.end!.sourceTime, baseline.sourceTime + 1_000_000)
})
test('a trade after cutoff cannot turn a flat result into a win', async () => {
  const h = harness(); await h.funded(); h.move(100); h.heartbeat()
  h.move(1001); h.tick(101); h.move(500); h.heartbeat()
  assert.equal(h.round.result, 'refund'); assert.match(h.round.reason, /^Price unchanged/)
})
test('same-ms trades are ordered and even a trade 1 microsecond after cutoff is excluded', async () => {
  const h = harness(); await h.funded(); h.move(100); h.heartbeat()
  h.move(1000)
  const exact = new Date(h.now()).toISOString().replace('Z', '000Z')
  h.tick(101, exact); h.tick(102, exact)
  h.tick(99, `${exact.slice(0, -2)}1Z`)
  h.move(1); h.heartbeat()
  assert.equal(h.round.result, 'player'); assert.equal(h.round.end!.price, 102)
})
test('thousands of trades after cutoff cannot evict the retained outcome', async () => {
  const h = harness(); await h.funded(); h.move(100); h.heartbeat()
  h.move(900); h.tick(101); h.move(101)
  for (let i = 0; i < 4000; i++) { h.tick(99); if (i % 100 === 0) h.move(1) }
  h.heartbeat()
  assert.ok(h.prices.ticks.length <= 32); assert.equal(h.round.result, 'player'); assert.equal(h.round.end!.price, 101)
})
test('missing trade ID, heartbeat coverage mismatch, or disconnect cannot settle a price result', async () => {
  for (const interrupt of [
    (h: ReturnType<typeof harness>) => h.frame({ type: 'match', trade_id: 100, price: '101' }),
    (h: ReturnType<typeof harness>) => h.heartbeat(100),
    (h: ReturnType<typeof harness>) => { h.prices.connected = false; h.round.advance() },
  ]) {
    const h = harness(); await h.funded(); h.move(100); h.heartbeat(); h.move(900); h.tick(101)
    h.move(100); interrupt(h)
    assert.equal(h.round.result, 'refund'); assert.equal(h.round.end, undefined)
    assert.match(h.round.reason, /^Price feed interrupted/); assert.equal(h.round.payments.length, 2)
  }
})
test('missing proof is bounded even while trades continue; a late heartbeat cannot change a refund', async () => {
  const h = harness(); await h.funded(); h.move(100); h.heartbeat()
  for (let elapsed = 0; elapsed < PROOF_WAIT + 1100; elapsed += 100) { h.move(100); h.tick(101); h.round.advance() }
  assert.equal(h.round.result, 'refund'); assert.equal(h.round.end, undefined)
  h.heartbeat(); assert.equal(h.round.payments.length, 2)
})
test('reconnect resync cannot silently continue the old round, but enables a new quiet-market round', async () => {
  const h = harness(); await h.funded(); h.move(100); h.heartbeat()
  h.prices.reset(); h.prices.connected = true; h.move(100)
  h.frame({ type: 'last_match', price: '100', trade_id: 500 }); h.heartbeat(500)
  assert.equal(h.round.result, 'refund'); assert.equal(h.round.end, undefined)
  h.round.payments.forEach(h.confirm); h.move(1000); h.heartbeat(500); h.round.advance()
  assert.equal(h.round.canStart, true)
  await h.funded(); h.move(1000); h.heartbeat(500); h.move(1000); h.heartbeat(500)
  assert.equal(h.round.result, 'refund'); assert.match(h.round.reason, /^Price unchanged/)
})

test('one direction tap starts inference and commits two stakes without a second click', async () => {
  let input: unknown, resolve!: (answer: { pick: 'up' | 'down'; inferenceMs: number }) => void
  const h = harness(snapshot => { input = snapshot; return new Promise(r => { resolve = r }) })
  const first = h.round.start('up')
  await h.round.start('down') // A repeated tap cannot change the choice or start a second bet.
  assert.equal(h.round.phase, 'thinking'); assert.equal(h.round.number, 1)
  assert.equal(h.ledger.transfers.length, 0)
  assert.deepEqual(Object.keys(input as object).sort(), ['ticks', 'version'])
  resolve({ pick: 'down', inferenceMs: 100 }); await first
  assert.equal(h.round.player, 'up'); assert.equal(h.round.jev, 'down')
  assert.equal(h.round.phase, 'funding'); assert.equal(h.ledger.transfers.length, 2)
})

test('direction taps fail closed on provider outage or visibility loss before inference returns', async () => {
  const outage = harness(async () => { throw new Error('offline') })
  await outage.round.start('up')
  assert.equal(outage.ledger.transfers.length, 0); assert.equal(outage.round.phase, 'done')
  let resolve!: (answer: { pick: 'up' | 'down'; inferenceMs: number }) => void
  const hidden = harness(() => new Promise(r => { resolve = r }))
  const pending = hidden.round.start('down'); hidden.hide()
  resolve({ pick: 'up', inferenceMs: 100 }); await pending
  assert.equal(hidden.ledger.transfers.length, 0); assert.equal(hidden.round.phase, 'done')
})

test('settlement re-enables the next direction tap, but never places another bet by itself', async () => {
  const h = harness(); await h.round.start('down')
  h.round.stakes.forEach(h.confirm); h.round.advance()
  h.round.payments.forEach(h.confirm); h.round.advance()
  assert.equal(h.round.canStart, true); const count = h.ledger.transfers.length
  h.pulse(2000); assert.equal(h.ledger.transfers.length, count); assert.equal(h.round.number, 1)
  await h.round.start('up'); assert.equal(h.round.number, 2)
  assert.equal(h.ledger.transfers.length, count + 2)
})

test('bounded exchange clock lead preserves the exact one-second cutoff and excludes later reversals', async () => {
  for (const skew of [260, 2000]) {
    const h = harness(); await h.funded()
    const sourceStart = h.now() + skew
    h.heartbeat(undefined, new Date(sourceStart).toISOString())
    assert.equal(h.round.phase, 'watching')
    h.move(750); h.tick(101, new Date(sourceStart + 750).toISOString())
    h.move(251); h.tick(99, new Date(sourceStart + 1001).toISOString())
    assert.equal(h.round.end, undefined)
    h.move(999); h.heartbeat(undefined, new Date(sourceStart + 2000).toISOString())
    assert.equal(h.round.end!.sourceTime - h.round.baseline!.sourceTime, 1_000_000)
    assert.equal(h.round.result, 'player', 'trade after the exchange cutoff cannot reverse the winner')
    assert.equal(h.round.payments.length, 1)
    assert.equal(h.round.payments[0].amount, 2n * STAKE)
  }
})
