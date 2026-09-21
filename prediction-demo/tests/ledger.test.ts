import test from 'node:test'
import assert from 'node:assert/strict'
import { Ledger, STAKE, outcome, phaseOutcome } from '../src/ledger.ts'
import { TRANSFER_TOPIC } from '../../fighter-demo/src/ledger.ts'
const token = '0x' + '11'.repeat(20), from = '0x' + '22'.repeat(20), to = '0x' + '33'.repeat(20), hash = '0x' + '44'.repeat(32)
const topic = (a: string) => '0x' + a.slice(2).padStart(64, '0')
test('exact amount, contract, from, to, hash, mined log and successful AA receipt are required', () => {
  const ledger = new Ledger({ player: 2n * STAKE, jev: 2n * STAKE, pot: 0n })
  const tx = ledger.create(1, 'player', 'pot', STAKE, 'Stake', 0); ledger.register(tx, hash)
  const log = { address: token, topics: [TRANSFER_TOPIC, topic(from), topic(to)], data: '0x' + STAKE.toString(16).padStart(64, '0'), transactionHash: hash, blockNumber: '0x1' }
  const receipt = { transactionHash: hash, status: '0x1', logs: [log], phaseStatuses: ['0x1'] }
  assert.equal(outcome(receipt, tx, token, from, to), 'confirmed')
  for (const invalid of [{ ...log, data: '0x' + (2n * STAKE).toString(16).padStart(64, '0') }, { ...log, address: from }, { ...log, transactionHash: token }, { ...log, removed: true }, { ...log, blockNumber: undefined }, { ...log, topics: [TRANSFER_TOPIC, topic(to), topic(from)] }]) assert.equal(outcome({ ...receipt, logs: [invalid] }, tx, token, from, to), 'unknown')
  assert.equal(outcome({ ...receipt, status: '0x0' }, tx, token, from, to), 'failed')
  assert.equal(outcome({ ...receipt, phaseStatuses: ['0x0'] }, tx, token, from, to), 'failed')
  assert.equal(outcome({ ...receipt, status: undefined }, tx, token, from, to), 'unknown')
  assert.equal(outcome({ ...receipt, transactionHash: token }, tx, token, from, to), 'unknown')
  for (const phaseStatuses of [undefined, null, [], [null], ['0x2'], ['0x1', '0x0'], ['0x1', '0x1'], '0x1', { 0: '0x1' }]) {
    assert.equal(outcome({ ...receipt, phaseStatuses }, tx, token, from, to), 'unknown', `Unsupported phase data: ${JSON.stringify(phaseStatuses)}`)
    assert.equal(outcome({ ...receipt, eip8130: { phaseStatuses }, phaseStatuses: undefined }, tx, token, from, to), 'unknown')
  }
  assert.equal(outcome({ ...receipt, eip8130: { phaseStatuses: ['0x1'] }, phaseStatuses: undefined }, tx, token, from, to), 'confirmed')
  assert.equal(outcome({ ...receipt, eip8130: { phaseStatuses: ['0x0'] } }, tx, token, from, to), 'failed')
  assert.equal(outcome({ ...receipt, status: '0x0', phaseStatuses: undefined }, tx, token, from, to), 'failed', 'Explicit outer revert is definitive even without phase metadata')
})
test('phase metadata distinguishes an explicit single revert from missing or unrecognized status', () => {
  assert.equal(phaseOutcome({}), 'unknown')
  assert.equal(phaseOutcome({ phaseStatuses: ['0x2'] }), 'unknown')
  assert.equal(phaseOutcome({ phaseStatuses: ['0x0'] }), 'failed')
  assert.equal(phaseOutcome({ eip8130: { phaseStatuses: ['0x1'] } }), 'confirmed')
  assert.equal(phaseOutcome({ phaseStatuses: ['0x01'] }), 'confirmed')
  assert.equal(phaseOutcome({ phaseStatuses: ['0x00'] }), 'failed')
})
test('pending debits reserve funds; unknown stays reserved; duplicate confirmation cannot double credit', () => {
  const ledger = new Ledger({ player: STAKE, jev: STAKE, pot: 0n })
  const tx = ledger.create(1, 'player', 'pot', STAKE, 'Stake', 0); ledger.register(tx, hash); tx.status = 'unknown'
  assert.equal(ledger.create(1, 'player', 'pot', STAKE, 'Duplicate', 0).status, 'failed')
  assert.equal(ledger.balances.player, STAKE)
  assert.equal(ledger.confirm(tx, 1, 200), true); assert.equal(ledger.confirm(tx, 1, 300), false)
  assert.equal(tx.latency, 200); assert.equal(ledger.balances.player, 0n); assert.equal(ledger.balances.pot, STAKE)
})
test('hash uniqueness is enforced before any broadcast and transfers cannot confirm without a hash', () => {
  const ledger = new Ledger({ player: STAKE, jev: STAKE, pot: 0n })
  const a = ledger.create(1, 'player', 'pot', STAKE, 'Stake', 0), b = ledger.create(1, 'jev', 'pot', STAKE, 'Stake', 0)
  assert.equal(ledger.confirm(a, 1, 10), false); ledger.register(a, hash)
  assert.throws(() => ledger.register(b, hash)); assert.equal(b.status, 'signing')
})
