import { emptyInput, type Combat, type Input, type Fighter } from './combat.ts'

export const JEV_MODEL = 'typesafe-ai/jev' as const
export const ACTIONS = ['punch', 'kick', 'block', 'approach', 'retreat', 'wait'] as const
export type JevAction = typeof ACTIONS[number]
export type Decision = { action: JevAction; model: typeof JEV_MODEL; inferenceMs: number }
export type ActiveDecision = Decision & { expiresAt: number; roundTripMs: number }
export const CADENCE_MS = 450
export const ACTION_TTL_MS = 650
export const MAX_SNAPSHOT_AGE_MS = 2_000
export const REQUEST_TIMEOUT_MS = 2_500

export function combatSnapshot(game: Combat) {
  const fighter = (f: Fighter) => ({
    x: Math.round(f.x), hp: f.hp, move: f.move,
    cooldownMs: Math.round(Math.max(0, f.nextAttack - game.elapsed)),
    sinceHitMs: Math.round(Math.min(10_000, Math.max(0, game.elapsed - f.lastHit))),
    combo: f.combo,
  })
  return { version: 1 as const, remainingMs: Math.round(game.remaining), player: fighter(game.fighters.player), jev: fighter(game.fighters.bot) }
}
export type Snapshot = ReturnType<typeof combatSnapshot>

export function parseDecision(value: unknown): Decision {
  if (!value || typeof value !== 'object') throw new Error('Invalid Jev response')
  const v = value as Record<string, unknown>
  if (v.model !== JEV_MODEL || typeof v.action !== 'string' || !(ACTIONS as readonly string[]).includes(v.action) ||
    typeof v.inferenceMs !== 'number' || !Number.isFinite(v.inferenceMs) || v.inferenceMs < 0 || v.inferenceMs > REQUEST_TIMEOUT_MS) throw new Error('Invalid Jev response')
  return { action: v.action as JevAction, model: JEV_MODEL, inferenceMs: v.inferenceMs }
}

/** Pure control adapter: never invents tactics, attacks, or movement. */
export function decisionInput(decision: ActiveDecision | null, now: number, playerX: number, jevX: number): Input {
  const input = emptyInput()
  if (!decision || now >= decision.expiresAt) return input
  const action = decision.action
  if (action === 'punch' || action === 'kick' || action === 'block') input[action] = true
  else if ((action === 'approach' || action === 'retreat') && playerX !== jevX) {
    const left = action === 'approach' ? jevX > playerX : jevX < playerX
    input.left = left; input.right = !left
  }
  return input
}

export function requestDecision(url: string, fetcher: typeof fetch = fetch) {
  return async (snapshot: Snapshot, signal: AbortSignal): Promise<Decision> => {
    const response = await fetcher(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(snapshot), credentials: 'omit', cache: 'no-store',
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    })
    if (!response.ok) throw new Error('Jev unavailable')
    return parseDecision(await response.json())
  }
}

type RequestDecision = (snapshot: Snapshot, signal: AbortSignal) => Promise<Decision>
/** Independent of combat time: waiting for inference must not stop the next request. */
export class JevController {
  private request: RequestDecision
  private clock: () => number
  private generation = 0
  private enabled = false
  private disposed = false
  private pending: AbortController | null = null
  private nextAt = 0
  private decision: ActiveDecision | null = null
  private unavailable = false
  private metrics: { inferenceMs: number; roundTripMs: number } | null = null
  constructor(request: RequestDecision, clock: () => number = () => performance.now()) { this.request = request; this.clock = clock }
  get view() {
    const decision = this.decision && this.clock() < this.decision.expiresAt ? this.decision : null
    return {
      status: !this.enabled ? 'paused' : decision ? 'live' : this.unavailable ? 'unavailable' : 'waiting',
      action: decision?.action ?? null,
      metrics: this.metrics,
    }
  }
  input(playerX: number, jevX: number): Input { return decisionInput(this.enabled ? this.decision : null, this.clock(), playerX, jevX) }
  suspend() {
    this.enabled = false; this.generation++; this.pending?.abort(); this.decision = null; this.nextAt = 0; this.unavailable = false
  }
  reset() { this.suspend(); this.metrics = null }
  dispose() { this.suspend(); this.disposed = true }
  tick(enabled: boolean, snapshot: () => Snapshot) {
    if (this.disposed) return
    if (!enabled) { if (this.enabled) this.suspend(); return }
    this.enabled = true
    const started = this.clock()
    if (this.pending || started < this.nextAt) return
    this.nextAt = started + CADENCE_MS
    const generation = this.generation, controller = new AbortController()
    this.pending = controller
    // Invoke immediately so the snapshot corresponds to this request, not a later frame.
    void this.run(snapshot(), controller, generation, started)
  }
  private async run(snapshot: Snapshot, controller: AbortController, generation: number, started: number) {
    const current = () => this.enabled && !this.disposed && generation === this.generation && !controller.signal.aborted
    try {
      const result = parseDecision(await this.request(snapshot, controller.signal))
      if (!current()) return
      const now = this.clock(), roundTripMs = now - started
      if (roundTripMs >= MAX_SNAPSHOT_AGE_MS) throw new Error('Stale snapshot')
      this.metrics = { inferenceMs: result.inferenceMs, roundTripMs: Math.round(roundTripMs) }
      this.decision = { ...result, roundTripMs, expiresAt: Math.min(now + ACTION_TTL_MS, started + MAX_SNAPSHOT_AGE_MS) }
      this.unavailable = false
    } catch {
      if (current()) { this.decision = null; this.unavailable = true; this.nextAt = this.clock() + 1_000 }
    } finally {
      if (this.pending === controller) this.pending = null
    }
  }
}
