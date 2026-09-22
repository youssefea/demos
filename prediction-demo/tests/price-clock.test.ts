import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_AGE, PriceBook, parseTick } from '../src/price.ts'
import { isPredictionSnapshot } from '../../fighter-ai/src/prediction-contract.ts'

const trade = (id: number, time: number, type = 'match') => ({ type, product_id: 'BTC-USD', trade_id: id, price: '86597.46', time: new Date(time).toISOString() })
const heartbeat = (id: number, time: number) => ({ type: 'heartbeat', product_id: 'BTC-USD', last_trade_id: id, time: new Date(time).toISOString() })

test('observed 260ms exchange clock lead keeps contiguous trades, heartbeat proof and API input live', () => {
  const start = 1_000_000, book = new PriceBook(); book.connected = true
  assert.ok(book.add(trade(1, start + 260, 'last_match'), start))
  assert.ok(book.add(heartbeat(1, start + 260), start))
  for (let second = 1; second <= 30; second++) {
    const now = start + second * 1000
    assert.ok(book.add(trade(second + 1, now + 260), now))
    assert.ok(book.add(heartbeat(second + 1, now + 260), now))
    assert.equal(book.fresh(now), true)
    assert.equal(book.error, '')
    assert.equal(isPredictionSnapshot(book.snapshot(now), now), true)
  }
})

test('clock tolerance is bounded at 2s and never extends receipt-age freshness', () => {
  const now = 1_000_000, book = new PriceBook(); book.connected = true
  assert.ok(parseTick(trade(1, now + 2000), now))
  assert.equal(parseTick(trade(1, now + 2001), now), null)
  book.add(trade(1, now + 2000, 'last_match'), now)
  assert.ok(book.add(heartbeat(1, now + 2000), now))
  assert.equal(book.fresh(now), true)
  assert.equal(book.fresh(now + MAX_AGE + 1), false, 'a future source clock cannot keep a silent connection live')
  const invalid = new PriceBook(); invalid.connected = true
  invalid.add(trade(1, now, 'last_match'), now)
  assert.equal(invalid.add(heartbeat(1, now + 2001), now), null)
  assert.equal(invalid.fresh(now), false)
})

test('API shares the 2s future bound while preserving its existing old-price rejection', () => {
  const now = 1_000_000
  const snapshot = (last: number) => ({ version: 1, ticks: [{ price: 100, time: last - 1000 }, { price: 101, time: last }] })
  assert.equal(isPredictionSnapshot(snapshot(now + 2000), now), true)
  assert.equal(isPredictionSnapshot(snapshot(now + 2001), now), false)
  assert.equal(isPredictionSnapshot(snapshot(now - MAX_AGE - 1), now), false)
})
