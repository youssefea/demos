import test from 'node:test'
import assert from 'node:assert/strict'
import { connectPrices, MAX_AGE, parseTick, PriceBook } from '../src/price.ts'
import { isPredictionSnapshot } from '../../fighter-ai/src/prediction-contract.ts'

const trade = (id: number, time: number, price = '100', type = 'match') => ({ type, product_id: 'BTC-USD', trade_id: id, price, time: new Date(time).toISOString() })
const heartbeat = (id: number, time: number) => ({ type: 'heartbeat', product_id: 'BTC-USD', last_trade_id: id, time: new Date(time).toISOString() })

test('old initial last_match plus current heartbeats yields fresh carry-forward samples without any new trade', () => {
  const now = 1_000_000, book = new PriceBook(); book.connected = true
  assert.ok(book.add(trade(1, now - 300_000, '100', 'last_match'), now))
  assert.equal(book.fresh(now), false)
  book.add(heartbeat(1, now), now); book.add(heartbeat(1, now + 1000), now + 1000)
  assert.equal(book.fresh(now + 1000), true)
  assert.deepEqual(book.snapshot(now + 1000).ticks, [{ price: 100, time: now }, { price: 100, time: now + 1000 }])
  assert.equal(isPredictionSnapshot(book.snapshot(now + 1000), now + 1000), true)
  for (let n = 2; n <= 40; n++) book.add(heartbeat(1, now + n * 1000), now + n * 1000)
  assert.ok(book.ticks.length <= 32); assert.equal(book.fresh(now + 40_000), true)
  assert.equal(book.fresh(now + 40_000 + MAX_AGE + 1), false)
})
test('same-ms ordered trades are emitted; duplicate/out-of-order old trades and heartbeat frames cannot change the quote', () => {
  const now = 1_000_000, book = new PriceBook(); book.connected = true
  book.add(trade(10, now - 1, '100', 'last_match'), now)
  book.add(heartbeat(10, now), now)
  assert.ok(book.add(trade(11, now, '101'), now))
  assert.ok(book.add(trade(12, now, '102'), now))
  assert.equal(book.add(trade(11, now, '101'), now), null)
  assert.equal(book.add(trade(10, now - 1, '100', 'last_match'), now), null)
  assert.equal(book.add(heartbeat(10, now), now), null)
  assert.equal(book.latest!.price, 102); assert.equal(book.error, '')
  book.add(heartbeat(12, now + 1000), now + 1000)
  assert.equal(isPredictionSnapshot(book.snapshot(now + 1000), now + 1000), true)
  assert.equal(book.ticks.filter(t => t.time === now).length, 1)
})
test('missing IDs and heartbeat last_trade_id in either direction poison coverage until reset', () => {
  const now = 1_000_000
  for (const bad of [trade(12, now + 100), heartbeat(12, now + 100), heartbeat(9, now + 100)]) {
    const book = new PriceBook(); book.connected = true
    book.add(trade(10, now, '100', 'last_match'), now); book.add(heartbeat(10, now), now)
    assert.equal(book.add(bad, now + 100), null); assert.ok(book.error); assert.equal(book.fresh(now + 100), false)
    assert.equal(book.add(heartbeat(10, now + 1000), now + 1000), null)
    const generation = book.generation
    book.reset(); book.connected = true
    book.add(trade(50, now + 1000, '99', 'last_match'), now + 1000); book.add(heartbeat(50, now + 1000), now + 1000)
    assert.equal(book.generation, generation + 1); assert.equal(book.fresh(now + 1000), true)
  }
})
test('source precision, bounded future skew, malformed values and heartbeat freshness checks', () => {
  const now = Date.parse('2026-09-21T23:12:24.000Z')
  const input = trade(1, now + 80)
  assert.ok(parseTick(input, now))
  assert.equal(parseTick({ ...input, time: '2026-09-21T23:12:24.080001Z' }, now)!.sourceTime, now * 1000 + 80_001)
  for (const bad of [{ ...input, price: 'NaN' }, { ...input, price: '0' }, { ...input, price: '1e5' }, { ...input, trade_id: 1.5 }, { ...input, time: 'invalid' }, { ...input, time: new Date(now + 251).toISOString() }, { ...input, product_id: 'ETH-USD' }, { ...input, type: 'ticker' }]) assert.equal(parseTick(bad, now), null)
  const book = new PriceBook(); book.connected = true
  book.add(trade(1, now - 10_000, '100', 'last_match'), now)
  assert.equal(book.add(heartbeat(1, now - MAX_AGE - 1), now), null)
  assert.equal(book.fresh(now), false)
  book.add(heartbeat(1, now + 80), now); assert.equal(book.fresh(now), true)
  assert.equal(book.fresh(now - 1), false, 'Backward receipt clock cannot appear fresh')
})
test('subscription reconnects after real coverage loss and silent timeout, and ignores old socket frames', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 })
  const sockets: FakeSocket[] = []
  class FakeSocket {
    onopen?: () => void; onclose?: () => void; onerror?: () => void; onmessage?: (event: { data: string }) => void
    sent: string[] = []; closed = false
    constructor() { sockets.push(this) }
    send(message: string) { this.sent.push(message) }
    close() { if (!this.closed) { this.closed = true; this.onclose?.() } }
    receive(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }) }
  }
  const original = globalThis.WebSocket
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket
  const book = new PriceBook(), observations: number[] = []
  let states = 0
  const stop = connectPrices(book, tick => observations.push(tick.tradeId), () => states++)
  try {
    const first = sockets[0]; first.onopen?.()
    assert.deepEqual(JSON.parse(first.sent[0]).channels, ['matches', 'heartbeat'])
    first.receive(trade(1, Date.now() - 10_000, '100', 'last_match')); first.receive(heartbeat(1, Date.now()))
    assert.equal(book.fresh(Date.now()), true)
    first.receive(trade(3, Date.now() + 1))
    assert.equal(first.closed, true); assert.equal(book.fresh(Date.now()), false)
    t.mock.timers.tick(1000)
    assert.equal(sockets.length, 2); sockets[1].onopen?.()
    sockets[1].receive(trade(20, Date.now() - 10_000, '101', 'last_match')); sockets[1].receive(heartbeat(20, Date.now()))
    assert.equal(book.fresh(Date.now()), true)
    const count = observations.length
    first.receive(trade(2, Date.now()))
    assert.equal(observations.length, count, 'Stale connection cannot contaminate resynced data')
    for (let i = 0; i < 6; i++) t.mock.timers.tick(1000)
    assert.ok(sockets.length >= 3); assert.equal(book.fresh(Date.now()), false)
    assert.ok(states >= 4)
    stop(); const total = sockets.length; t.mock.timers.tick(10_000); assert.equal(sockets.length, total)
  } finally { stop(); globalThis.WebSocket = original }
})
