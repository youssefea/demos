import { other, type Side } from './ledger.ts'
export type Move = 'idle' | 'walk' | 'punch' | 'kick' | 'block' | 'hit' | 'ko'
export type Fighter = { side: Side; x: number; hp: number; move: Move; poseUntil: number; nextAttack: number; combo: number; lastHit: number }
export type Input = { left: boolean; right: boolean; punch: boolean; kick: boolean; block: boolean }
export const emptyInput = (): Input => ({ left: false, right: false, punch: false, kick: false, block: false })
export type CombatEvent = { kind: 'hit' | 'block' | 'miss'; attacker: Side; victim: Side; x: number; move: 'punch' | 'kick'; combo: number }
export const MAX_HP = 180
export class Combat {
  readonly fighters: Record<Side, Fighter> = {
    player: { side: 'player', x: 232, hp: MAX_HP, move: 'idle', poseUntil: 0, nextAttack: 0, combo: 0, lastHit: -10_000 },
    bot: { side: 'bot', x: 408, hp: MAX_HP, move: 'idle', poseUntil: 0, nextAttack: 0, combo: 0, lastHit: -10_000 },
  }
  elapsed = 0
  countdown = 2_400
  remaining = 60_000
  finished = false
  winner: Side | 'draw' | null = null
  hits = { player: 0, bot: 0 }
  private rng: () => number
  constructor(rng: () => number = Math.random) { this.rng = rng }
  step(dt: number, input: Input, pay: (victim: Side) => boolean, event: (event: CombatEvent) => void, aiInput: Input = emptyInput()) {
    if (this.finished || dt <= 0) return
    // Never catch up hidden-tab time or pay for missed animation frames.
    dt = Math.min(dt, 50)
    if (this.countdown > 0) { this.countdown = Math.max(0, this.countdown - dt); return }
    this.elapsed += dt
    this.remaining = Math.max(0, this.remaining - dt)
    const p = this.fighters.player, b = this.fighters.bot
    for (const f of [p, b]) {
      if (this.elapsed >= f.poseUntil) f.move = 'idle'
      if (this.elapsed - f.lastHit > 1_100) f.combo = 0
    }
    const playerBlocking = input.block && this.elapsed >= p.poseUntil
    if (playerBlocking) p.move = 'block'
    if (aiInput.block && this.elapsed >= b.poseUntil) b.move = 'block'
    if (!playerBlocking && this.elapsed >= p.poseUntil) {
      const direction = Number(input.right) - Number(input.left)
      if (direction) { p.x += direction * dt * .18; p.move = 'walk' }
    }
    // Jev supplies explicit input only; no scripted fallback when inference is absent.
    if (!aiInput.block && this.elapsed >= b.poseUntil) {
      const direction = Number(aiInput.right) - Number(aiInput.left)
      if (direction) { b.x += direction * dt * .10; b.move = 'walk' }
    }
    p.x = Math.max(45, Math.min(p.x, 555)); b.x = Math.max(85, Math.min(b.x, 595))
    if (b.x - p.x < 44) { const mid = Math.max(67, Math.min(573, (b.x + p.x) / 2)); p.x = mid - 22; b.x = mid + 22 }
    if (!input.block) {
      if (input.kick) this.attack('player', 'kick', pay, event)
      else if (input.punch) this.attack('player', 'punch', pay, event)
    }
    if (!aiInput.block) {
      if (aiInput.kick) this.attack('bot', 'kick', pay, event)
      else if (aiInput.punch) this.attack('bot', 'punch', pay, event)
    }
    if (p.hp <= 0 || b.hp <= 0 || this.remaining <= 0) this.finish()
  }
  attack(side: Side, move: 'punch' | 'kick', pay: (victim: Side) => boolean, event: (event: CombatEvent) => void): boolean {
    if (this.finished || this.countdown > 0) return false
    const attacker = this.fighters[side], victim = this.fighters[other(side)]
    if (this.elapsed < attacker.nextAttack || attacker.move === 'block' || attacker.move === 'hit' && this.elapsed < attacker.poseUntil) return false
    const range = move === 'punch' ? 84 : 108
    // Preserve the opponent's slower 500–800ms attack guard, including misses.
    attacker.nextAttack = this.elapsed + (side === 'bot' ? 500 + this.rng() * 300 : move === 'punch' ? 230 : 300)
    attacker.move = move; attacker.poseUntil = this.elapsed + (move === 'punch' ? 160 : 220)
    const detail = { attacker: side, victim: victim.side, x: victim.x, move, combo: attacker.combo }
    if (Math.abs(victim.x - attacker.x) > range) { event({ ...detail, kind: 'miss' }); return false }
    if (victim.move === 'block') { event({ ...detail, kind: 'block' }); return false }
    // Reserve transfer capacity synchronously before a hit can damage either fighter.
    if (!pay(victim.side)) return false
    victim.hp = Math.max(0, victim.hp - (move === 'punch' ? 2 : 3))
    victim.move = 'hit'; victim.poseUntil = this.elapsed + 85
    victim.x = Math.max(45, Math.min(595, victim.x + (side === 'player' ? 3 : -3)))
    attacker.combo = this.elapsed - attacker.lastHit < 1_100 ? attacker.combo + 1 : 1
    attacker.lastHit = this.elapsed
    this.hits[side]++
    event({ ...detail, kind: 'hit', combo: attacker.combo })
    if (victim.hp === 0) this.finish()
    return true
  }
  finish() {
    this.finished = true
    const p = this.fighters.player, b = this.fighters.bot
    this.winner = p.hp === b.hp ? 'draw' : p.hp > b.hp ? 'player' : 'bot'
    if (p.hp === 0) p.move = 'ko'
    if (b.hp === 0) b.move = 'ko'
  }
}
