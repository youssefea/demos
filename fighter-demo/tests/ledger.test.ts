import test from 'node:test'
import assert from 'node:assert/strict'
import { HIT_UNITS, Ledger, matchesTransfer, MAX_IN_FLIGHT, MATCH_LIMIT, receiptOutcome, SESSION_LIMIT, TRANSFER_TOPIC, type RawLog } from '../src/ledger.ts'
const token = `0x${'aa'.repeat(20)}`, player = `0x${'11'.repeat(20)}`, bot = `0x${'22'.repeat(20)}`
const topic = (address: string) => `0x${address.slice(2).padStart(64, '0')}`
const hash = `0x${'ff'.repeat(32)}`
const event = (overrides: Partial<RawLog> = {}): RawLog => ({ address: token, transactionHash: hash, topics: [TRANSFER_TOPIC, topic(bot), topic(player)], data: `0x${HIT_UNITS.toString(16).padStart(64, '0')}`, blockNumber: '0x123', ...overrides })
const funded = () => new Ledger(1_000_000_000n, 1_000_000_000n)

test('full ERC20 validation requires token, both directions, amount, hash, mined nonremoved log', () => {
  assert.equal(matchesTransfer(event(), hash, token, bot, player), true)
  for (const invalid of [event({ address: player }), event({ transactionHash: '0x123' }), event({ data: '0x00' }), event({ removed: true }), event({ blockNumber: undefined }), event({ topics: [TRANSFER_TOPIC, topic(player), topic(bot)] }), event({ topics: [] }), event({ data: `0x${'0'.repeat(64)}` })]) {
    assert.equal(matchesTransfer(invalid, hash, token, bot, player), false)
  }
  assert.equal(matchesTransfer(event({ blockNumber: 'garbage' }), hash, token, bot, player), false)
})
test('matching WSS notification can arrive inside broadcast before acknowledgement', async () => {
  const ledger = funded(), tx = ledger.reserve('bot', 100)!
  ledger.register(tx.id, hash)
  const broadcast = async () => {
    assert.ok(ledger.transfers.some(t => t.hash === hash && t.status === 'pending'))
    if (matchesTransfer(event(), hash, token, bot, player)) ledger.confirm(hash, 291, 250)
    return hash
  }
  await broadcast()
  assert.equal(tx.status, 'confirmed'); assert.equal(tx.latency, 150)
  assert.equal(ledger.balances.player, 1_000_050_000n)
})
test('duplicate WSS and later receipt confirm exactly once', () => {
  const ledger = funded(), tx = ledger.reserve('bot', 0)!
  ledger.register(tx.id, hash)
  assert.ok(ledger.confirm(hash, 123, 200)); assert.equal(ledger.confirm(hash, 123, 300), null)
  assert.equal(ledger.confirmed.length, 1); assert.equal(ledger.balances.bot, 999_950_000n)
})
test('out-of-order confirmations in opposite directions conserve funds', () => {
  const ledger = funded(), first = ledger.reserve('bot', 0)!, second = ledger.reserve('player', 10)!
  ledger.register(first.id, hash); ledger.register(second.id, '0xsecond')
  ledger.confirm('0xsecond', 123, 150); ledger.confirm(hash, 122, 160)
  assert.equal(ledger.confirmed.length, 2)
  assert.deepEqual(ledger.balances, { player: 1_000_000_000n, bot: 1_000_000_000n })
  assert.equal(ledger.confirm('0xunregistered', 123, 160), null)
})
test('successful receipt without matching event is unknown, never credited', () => {
  const valid = { transactionHash: hash, status: '0x1', logs: [event()] }
  assert.equal(receiptOutcome(valid, true, hash, token, bot, player), 'confirmed')
  assert.equal(receiptOutcome({ ...valid, logs: [] }, true, hash, token, bot, player), 'unknown')
  assert.equal(receiptOutcome({ ...valid, status: undefined }, true, hash, token, bot, player), 'unknown')
  assert.equal(receiptOutcome({ ...valid, transactionHash: '0xwrong' }, true, hash, token, bot, player), 'unknown')
  assert.equal(receiptOutcome({ ...valid, logs: [event({ address: player })] }, true, hash, token, bot, player), 'unknown')
})
test('reverted outer or inner phase prevents receipt credit', () => {
  assert.equal(receiptOutcome({ transactionHash: hash, status: '0x0', logs: [event()] }, true, hash, token, bot, player), 'failed')
  assert.equal(receiptOutcome({ transactionHash: hash, status: '0x1', logs: [event()] }, false, hash, token, bot, player), 'failed')
  const ledger = funded(), tx = ledger.reserve('bot', 0)!
  ledger.register(tx.id, hash); ledger.fail(tx.id, 'Reverted')
  assert.equal(ledger.balances.bot, 1_000_000_000n); assert.equal(ledger.unresolved.length, 0)
})
test('unknown reserves capacity and funds; late validated confirmation resolves it', () => {
  const ledger = funded(), tx = ledger.reserve('player', 0)!
  ledger.register(tx.id, hash); ledger.unknown(tx.id, 'RPC timeout')
  assert.equal(ledger.balances.player, 1_000_000_000n)
  assert.equal(ledger.reserve('bot', 10), null); assert.equal(ledger.newMatch(), false)
  ledger.confirm(hash, 123, 40_000)
  assert.equal(tx.status, 'confirmed'); assert.equal(tx.latency, 40_000)
  assert.equal(ledger.reason, null); assert.equal(ledger.newMatch(), true)
})
test('signing reservations enforce hard in-flight limit even before hashes exist', () => {
  const ledger = funded()
  for (let i = 0; i < MAX_IN_FLIGHT; i++) assert.ok(ledger.reserve('bot', i))
  assert.equal(ledger.reserve('player', 50), null); assert.equal(ledger.unresolved.length, MAX_IN_FLIGHT)
  ledger.fail(1, 'Local signing error, never broadcast')
  assert.ok(ledger.reserve('bot', 60)); assert.equal(ledger.unresolved.length, MAX_IN_FLIGHT)
})
test('fund reservation never overspends the victim balance', () => {
  const ledger = new Ledger(HIT_UNITS, HIT_UNITS)
  assert.ok(ledger.reserve('bot', 0)); assert.equal(ledger.reserve('bot', 10), null)
  assert.equal(ledger.balances.bot, HIT_UNITS)
})
test('match spend and session attempt bounds persist across rematches and failures', () => {
  const ledger = funded()
  for (let i = 0; i < SESSION_LIMIT; i++) {
    if (ledger.matchCount === MATCH_LIMIT) assert.equal(ledger.newMatch(), true)
    const tx = ledger.reserve('bot', i)!
    assert.ok(tx); ledger.fail(tx.id, 'Never sent')
  }
  assert.equal(ledger.reserve('bot', 1_001), null); assert.equal(ledger.newMatch(), false)
  assert.match(ledger.reason!, /Session limit/)
})
test('registered hash uniqueness and terminal confirmation resist stale error handlers', () => {
  const ledger = funded(), a = ledger.reserve('bot', 0)!, b = ledger.reserve('bot', 0)!
  assert.equal(ledger.register(a.id, hash), true); assert.equal(ledger.register(b.id, hash), false)
  ledger.confirm(hash, 1, 200); ledger.fail(a.id, 'Late broadcast error'); ledger.unknown(a.id, 'Late timeout')
  assert.equal(a.status, 'confirmed'); assert.equal(ledger.balances.player, 1_000_050_000n)
})
