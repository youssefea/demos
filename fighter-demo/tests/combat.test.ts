import test from 'node:test'
import assert from 'node:assert/strict'
import { Combat, emptyInput, MAX_HP } from '../src/combat.ts'
import { Ledger } from '../src/ledger.ts'
const noop = () => {}
const close = () => {
  const g = new Combat(() => .5)
  g.countdown = 0; g.fighters.player.x = 240; g.fighters.bot.x = 300
  return g
}
test('punch reserves exactly one victim transfer and applies damage', () => {
  const g = close(), ledger = new Ledger(1_000_000n, 1_000_000n)
  assert.equal(g.attack('player', 'punch', v => !!ledger.reserve(v, 0), noop), true)
  assert.equal(ledger.transfers.length, 1); assert.equal(ledger.transfers[0].victim, 'bot')
  assert.equal(g.fighters.bot.hp, MAX_HP - 2)
  assert.equal(ledger.balances.bot, 1_000_000n, 'combat cannot optimistically debit balances')
})
test('blocked hit and out-of-range kick never pay', () => {
  const g = close(); let sent = 0
  g.fighters.bot.move = 'block'
  assert.equal(g.attack('player', 'punch', () => { sent++; return true }, noop), false)
  g.elapsed = 400; g.fighters.bot.move = 'idle'; g.fighters.bot.x = 500
  assert.equal(g.attack('player', 'kick', () => { sent++; return true }, noop), false)
  assert.equal(sent, 0); assert.equal(g.fighters.bot.hp, MAX_HP)
})
test('cooldown allows 230ms punches, prevents repeat-frame/double inputs', () => {
  const g = close(); let sent = 0
  const pay = () => { sent++; return true }
  g.attack('player', 'punch', pay, noop)
  g.elapsed = 229; g.attack('player', 'punch', pay, noop)
  assert.equal(sent, 1)
  g.elapsed = 230; g.attack('player', 'punch', pay, noop)
  assert.equal(sent, 2); assert.equal(g.fighters.player.combo, 2)
})
test('backpressure prevents damage and does not accumulate delayed hits', () => {
  const g = close()
  g.attack('player', 'kick', () => false, noop)
  assert.equal(g.fighters.bot.hp, MAX_HP); assert.equal(g.hits.player, 0)
  g.elapsed = 300; g.attack('player', 'kick', () => true, noop)
  assert.equal(g.hits.player, 1); assert.equal(g.fighters.bot.hp, MAX_HP - 3)
})
test('bot pays from player account on its successful hit', () => {
  const g = close(); const victims: string[] = []
  g.attack('bot', 'kick', victim => { victims.push(victim); return true }, noop)
  assert.deepEqual(victims, ['player']); assert.equal(g.fighters.player.hp, MAX_HP - 3)
})
test('KO and expired clock stop all subsequent transfers', () => {
  const g = close(); g.fighters.bot.hp = 2
  g.attack('player', 'punch', () => true, noop)
  assert.equal(g.finished, true); assert.equal(g.winner, 'player'); assert.equal(g.fighters.bot.move, 'ko')
  assert.equal(g.attack('player', 'kick', () => { throw new Error('must not send') }, noop), false)
  const clock = close(); clock.remaining = 10
  clock.step(20, emptyInput(), () => true, noop)
  assert.equal(clock.remaining, 0); assert.equal(clock.finished, true)
})
test('countdown never sends; long frame never catches up hidden-tab time', () => {
  const g = new Combat(() => .5)
  g.step(60_000, { ...emptyInput(), punch: true }, () => { throw new Error('must not send') }, noop)
  assert.equal(g.remaining, 60_000); assert.equal(g.countdown, 2_350)
  g.countdown = 0; g.step(60_000, emptyInput(), () => true, noop)
  assert.equal(g.remaining, 59_950)
})
test('explicit opponent attacks produce a 60-second round; blocking prevents payments', () => {
  const g = close(); let hits = 0
  for (let i = 0; i < 1_200; i++) g.step(50, { ...emptyInput(), block: true }, () => { hits++; return true }, noop, { ...emptyInput(), kick: true })
  assert.equal(g.finished, true); assert.equal(hits, 0); assert.equal(g.fighters.player.hp, MAX_HP)
})
test('movement stays in arena and fighters cannot overlap', () => {
  const g = close()
  for (let i = 0; i < 100; i++) g.step(50, { ...emptyInput(), right: true }, () => true, noop)
  assert.ok(g.fighters.bot.x - g.fighters.player.x >= 44)
  assert.ok(g.fighters.player.x >= 45 && g.fighters.bot.x <= 595)
})

test('without explicit Jev input there is no scripted movement, blocking or attack', () => {
  const g = close(); const before = g.fighters.bot.x
  for (let i = 0; i < 100; i++) g.step(50, emptyInput(), () => { throw new Error('no fallback payment') }, noop)
  assert.equal(g.fighters.bot.x, before); assert.equal(g.fighters.bot.move, 'idle')
})
test('Jev held attacks obey original slower cooldown and victim payment direction', () => {
  const g = close(), victims: string[] = []
  const ai = { ...emptyInput(), punch: true }, pay = (victim: string) => { victims.push(victim); return true }
  g.step(50, emptyInput(), pay, noop, ai)
  assert.deepEqual(victims, ['player']); assert.equal(g.fighters.bot.nextAttack, 700)
  for (let i = 0; i < 12; i++) g.step(50, emptyInput(), pay, noop, ai)
  g.step(49, emptyInput(), pay, noop, ai); assert.equal(victims.length, 1)
  g.step(1, emptyInput(), pay, noop, ai); assert.deepEqual(victims, ['player', 'player'])
})
test('explicit Jev approach/retreat/block respect movement speed, guard and pose locks', () => {
  const g = close()
  g.step(50, emptyInput(), () => true, noop, { ...emptyInput(), left: true })
  assert.equal(g.fighters.bot.x, 295)
  g.step(50, emptyInput(), () => true, noop, { ...emptyInput(), right: true })
  assert.equal(g.fighters.bot.x, 300)
  g.step(50, { ...emptyInput(), punch: true }, () => { throw new Error('blocked hit must not pay') }, noop, { ...emptyInput(), block: true, left: true, kick: true })
  assert.equal(g.fighters.bot.move, 'block'); assert.equal(g.fighters.bot.x, 300)
  assert.equal(g.fighters.bot.hp, MAX_HP)
  g.fighters.bot.move = 'hit'; g.fighters.bot.poseUntil = g.elapsed + 85
  g.step(50, emptyInput(), () => { throw new Error('hit stun must not pay') }, noop, { ...emptyInput(), punch: true, left: true })
  assert.equal(g.fighters.bot.x, 300)
})
