import test from 'node:test'
import assert from 'node:assert/strict'
import { Round, ROUND_LIMIT, type Inference, type Network } from '../src/round.ts'
import { Ledger, STAKE, type Transfer } from '../src/ledger.ts'
import { PriceBook, endTick, parseTick, type Tick } from '../src/price.ts'

function harness(infer: Inference = async () => ({ pick: 'down', inferenceMs: 100 })) {
  let now = 1_000_000, visible = true, tradeId = 0
  const prices = new PriceBook(); prices.connected = true
  const ledger = new Ledger({ player: 20n * STAKE, jev: 20n * STAKE, pot: 0n })
  const net: Network = { ledger, blocked: null, send: (round, from, to, amount, label) => {
    const tx = ledger.create(round, from, to, amount, label, now)
    if (tx.status === 'signing') ledger.register(tx, `0x${tx.id.toString(16).padStart(64, '0')}`)
    return tx
  } }
  const round = new Round(net, prices, infer, () => now, () => now, () => visible)
  const tick = (price = 100) => {
    const t = prices.add({ type: 'ticker', product_id: 'BTC-USD', price: String(price), time: new Date(now).toISOString(), trade_id: ++tradeId }, now)!
    round.onTick(t); return t
  }
  tick(); now += 100; tick()
  const pulse = (ms: number, price = 100, feed = true) => { for (let n = 0; n < ms; n += 50) { now += 50; if (feed && n % 200 === 150) tick(price); round.advance() } }
  const confirm = (tx: Transfer) => ledger.confirm(tx, 100, now)
  const funded = async (pick: 'up' | 'down' = 'up') => { await round.start(); round.pick(pick); round.stakes.forEach(confirm); round.advance() }
  return { round, ledger, net, prices, tick, pulse, confirm, funded, now: () => now, hide: () => { visible = false }, jump: (ms: number) => { now += ms; round.advance() } }
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
test('missed pick, hidden tab, stale feed, delayed scheduling all fail closed without new stakes', async () => {
  for (const abort of [(h: ReturnType<typeof harness>) => h.pulse(1100), (h: ReturnType<typeof harness>) => { h.hide(); h.round.advance() }, (h: ReturnType<typeof harness>) => h.pulse(800, 100, false), (h: ReturnType<typeof harness>) => h.jump(401)]) {
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
test('a newly received endpoint cannot erase a stale previous receipt gap', () => {
  const baseline: Tick = { price: 100, time: 1_000_000, receivedAt: 1_000_000, tradeId: 1 }
  const previous: Tick = { price: 100, time: 1_000_650, receivedAt: 1_000_400, tradeId: 2 }
  const endpoint: Tick = { price: 101, time: 1_001_150, receivedAt: 1_001_160, tradeId: 3 }
  // Source gap is only 500ms and end is inside +250ms tolerance, but receipts are 760ms apart.
  assert.equal(endTick(baseline, previous, endpoint), 'invalid')
  assert.equal(endTick(baseline, previous, { ...endpoint, receivedAt: 1_001_150 }), 'end')
})
test('source timestamp checks, monotonic dedup and bounded endpoint tolerance', () => {
  const now = 1_000_000
  const input = { type: 'ticker', product_id: 'BTC-USD', price: '64000.12', time: new Date(now + 80).toISOString(), trade_id: 1 }
  assert.ok(parseTick(input, now)); assert.equal(parseTick({ ...input, time: new Date(now + 251).toISOString() }, now), null)
  assert.equal(parseTick({ ...input, time: new Date(now - 751).toISOString() }, now), null)
  assert.equal(parseTick({ ...input, price: 'NaN' }, now), null); assert.equal(parseTick({ ...input, product_id: 'ETH-USD' }, now), null)
  const book = new PriceBook(); assert.ok(book.add(input, now)); assert.equal(book.add(input, now), null)
  for (let i = 2; i < 100; i++) book.add({ ...input, trade_id: i, time: new Date(now + i * 100).toISOString() }, now + i * 100)
  assert.equal(book.ticks.length, 32)
  const t = (time: number): Tick => ({ time, receivedAt: time, price: 1, tradeId: time })
  assert.equal(endTick(t(1000), t(1700), t(1999)), 'wait')
  assert.equal(endTick(t(1000), t(1700), t(2000)), 'end')
  assert.equal(endTick(t(1000), t(1700), t(2250)), 'end')
  assert.equal(endTick(t(1000), t(1700), t(2251)), 'invalid')
  assert.equal(endTick(t(1000), t(1000), t(2000)), 'invalid')
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
