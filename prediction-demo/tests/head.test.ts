import test from 'node:test'
import assert from 'node:assert/strict'
import { ChainHead } from '../src/head.ts'

test('delayed HTTP head behind a newer WSS head cannot create a reset or invalidate freshness', async () => {
  const head = new ChainHead(99)
  let resolveHTTP!: (height: number) => void
  const response = new Promise<number>(resolve => { resolveHTTP = resolve })
  const http = response.then(height => head.observe(height, 500))
  head.observe(110, 200) // WSS advances while the HTTP request for head 100 is in flight.
  resolveHTTP(100); await http
  assert.equal(head.number, 110)
  assert.equal(head.seenAt, 200)
  assert.equal(head.stale(500), false, 'Delayed transport cannot stop signing/receipt reconciliation as a reset')
  head.observe(111, 600); assert.equal(head.number, 111); assert.equal(head.seenAt, 600)
})
test('duplicate/backward/malformed heads do not keep a stopped chain artificially fresh', () => {
  const head = new ChainHead(100)
  assert.equal(head.stale(1), true)
  head.observe(101, 100)
  for (const value of [101, 99, NaN, Infinity, -1, 101.5]) head.observe(value, 9000)
  assert.equal(head.number, 101); assert.equal(head.seenAt, 100); assert.equal(head.stale(9000), true)
})
