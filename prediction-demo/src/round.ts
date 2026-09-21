import { isPick, type Pick, type PredictionSnapshot } from '../../fighter-ai/src/prediction-contract.ts'
import { endTick, END_TOLERANCE, MAX_AGE, PRICE_WINDOW, PriceBook, type Tick } from './price.ts'
import { Ledger, STAKE, unresolved, type Account, type Transfer } from './ledger.ts'
export const ROUND_LIMIT = 20
export type Phase = 'idle' | 'thinking' | 'picking' | 'funding' | 'baseline' | 'watching' | 'settling' | 'done' | 'blocked'
export type Result = 'player' | 'jev' | 'refund'
export type Network = { ledger: Ledger; blocked: string | null; send: (round: number, from: Account, to: Account, amount: bigint, label: string) => Transfer }
export type Inference = (snapshot: PredictionSnapshot, signal: AbortSignal) => Promise<{ pick: Pick; inferenceMs: number }>
export class Round {
  phase: Phase = 'idle'; number = 0; player?: Pick; private decision?: Pick
  inferenceMs?: number; result?: Result; reason = ''; deadline = 0
  baseline?: Tick; end?: Tick
  stakes: Transfer[] = []; payments: Transfer[] = []
  private previous?: Tick; private baselineAfter = 0; private abortReason = ''
  private controller?: AbortController; private lastPulse = 0; private lastWall = 0
  private net: Network; private prices: PriceBook; private infer: Inference
  private now: () => number; private mono: () => number; private visible: () => boolean
  constructor(net: Network, prices: PriceBook, infer: Inference, now = Date.now, mono = () => performance.now(), visible = () => !document.hidden) {
    this.net = net; this.prices = prices; this.infer = infer; this.now = now; this.mono = mono; this.visible = visible
  }
  get jev() { return this.player ? this.decision : undefined }
  get active() { return !['idle', 'done', 'blocked'].includes(this.phase) }
  get unsettled() { return this.active || this.phase === 'blocked' || this.net.ledger.pending.length > 0 || this.net.ledger.balances.pot > 0n }
  get canStart() {
    return !this.unsettled && this.number < ROUND_LIMIT && !this.net.blocked && this.visible() && this.prices.fresh(this.now()) && this.prices.snapshot(this.now()).ticks.length >= 2 && this.net.ledger.balances.player >= STAKE && this.net.ledger.balances.jev >= STAKE
  }
  async start() {
    if (!this.canStart) return
    this.number++; this.phase = 'thinking'; this.reason = 'Jev is making an independent prediction…'
    this.player = undefined; this.decision = undefined; this.baseline = undefined; this.end = undefined; this.previous = undefined
    this.result = undefined; this.abortReason = ''; this.stakes = []; this.payments = []; this.inferenceMs = undefined
    this.lastPulse = this.mono(); this.lastWall = this.now()
    const controller = new AbortController(); this.controller = controller
    const timer = setTimeout(() => controller.abort(), 3_000)
    try {
      const answer = await this.infer(this.prices.snapshot(this.now()), controller.signal)
      if (this.controller !== controller) return
      this.advance()
      if (controller.signal.aborted || this.phase !== 'thinking') return
      if (!isPick(answer.pick) || !Number.isFinite(answer.inferenceMs) || answer.inferenceMs < 0) throw new Error('Invalid Jev answer')
      this.decision = answer.pick; this.inferenceMs = answer.inferenceMs
      this.phase = 'picking'; this.deadline = this.now() + 1_000; this.reason = 'Your turn. Pick within one second.'
    } catch { if (this.controller === controller && this.phase === 'thinking') this.abort('Jev unavailable. No stakes submitted. Try another round.') }
    finally { clearTimeout(timer); if (this.controller === controller && this.phase === 'thinking') this.abort('Jev timed out. No stakes submitted.') }
  }
  pick(pick: Pick) {
    this.advance()
    if (this.phase !== 'picking' || this.now() >= this.deadline || !isPick(pick)) return
    this.player = pick; this.phase = 'funding'; this.reason = 'Both choices locked. Confirming two 1.00-USDV stakes…'
    this.stakes = [this.net.send(this.number, 'player', 'pot', STAKE, 'Your stake'), this.net.send(this.number, 'jev', 'pot', STAKE, 'Jev’s stake')]
  }
  abort(reason: string) {
    if (!this.active || this.phase === 'settling') return // Once the observed result is fixed, finish its payments.
    this.controller?.abort(); this.abortReason ||= reason; this.reason = this.abortReason
    if (!this.stakes.length) { this.result = 'refund'; this.phase = 'done' }
    else { this.phase = 'funding'; this.finishFunding() }
  }
  private finishFunding() {
    if (this.stakes.some(unresolved)) return // UNKNOWN is never a failed stake, and cannot be refunded speculatively.
    if (this.abortReason || this.stakes.some(tx => tx.status === 'failed')) {
      this.settle('refund', this.abortReason || 'A stake failed. Refunding confirmed contributions only.')
    } else if (this.player === this.decision) this.settle('refund', 'Same prediction. Both stakes are returned.')
    else {
      this.phase = 'baseline'; this.baselineAfter = this.now(); this.deadline = this.now() + 2_000
      this.reason = 'Stakes confirmed. Waiting for a new baseline trade…'
    }
  }
  onTick(tick: Tick) {
    this.advance()
    if (this.phase === 'baseline' && tick.receivedAt >= this.baselineAfter && tick.time >= this.baselineAfter) {
      this.baseline = tick; this.previous = tick; this.phase = 'watching'; this.deadline = tick.time + PRICE_WINDOW
      this.reason = 'One-second price window is live.'
    } else if (this.phase === 'watching' && this.baseline && this.previous) {
      const status = endTick(this.baseline, this.previous, tick)
      this.previous = tick
      if (status === 'invalid') this.abort('Price gap or late endpoint. Returning both stakes.')
      else if (status === 'end') {
        this.end = tick
        const direction = tick.price > this.baseline.price ? 'up' : tick.price < this.baseline.price ? 'down' : null
        const winner = direction === null ? 'refund' : direction === this.player ? 'player' : 'jev'
        this.settle(winner, direction === null ? 'Price unchanged. Both stakes are returned.' : `${winner === 'player' ? 'You win' : 'Jev wins'} the price prediction. Confirming payout…`)
      }
    }
  }
  advance() {
    const now = this.now(), mono = this.mono()
    if (this.active && this.phase !== 'settling') {
      if (!this.visible()) this.abort('Tab hidden. Returning confirmed stakes.')
      else if (mono - this.lastPulse > 400 || Math.abs((now - this.lastWall) - (mono - this.lastPulse)) > 250) this.abort('Timer delayed or clock changed. Returning confirmed stakes.')
      else if (!this.prices.fresh(now)) this.abort('Price feed stale or disconnected. Returning confirmed stakes.')
      else if (this.net.blocked) this.abort('Network unavailable. Returning confirmed stakes when safe.')
    }
    this.lastPulse = mono; this.lastWall = now
    if (this.phase === 'picking' && now >= this.deadline) this.abort('No pick within one second. No stakes submitted.')
    if (this.phase === 'funding') this.finishFunding()
    if (this.phase === 'baseline' && now > this.deadline) this.abort('No fresh baseline trade. Returning both stakes.')
    if (this.phase === 'watching' && now > this.deadline + END_TOLERANCE + MAX_AGE) this.abort('No qualifying endpoint trade. Returning both stakes.')
    if (this.phase === 'settling' && this.payments.every(tx => !unresolved(tx))) {
      if (this.payments.some(tx => tx.status === 'failed')) { this.phase = 'blocked'; this.reason = 'A settlement transfer failed. Funds may remain in the pot; new rounds are blocked. Do not reload.' }
      else { this.phase = 'done'; this.reason = this.result === 'refund' ? `${this.reason} Refunds confirmed.` : `${this.result === 'player' ? 'You won' : 'Jev won'} 1.00 test USDV net. Payout confirmed.` }
    }
  }
  private settle(result: Result, reason: string) {
    if (this.phase === 'settling' || this.phase === 'done' || this.phase === 'blocked') return
    this.result = result; this.reason = reason; this.phase = 'settling'
    this.payments = result === 'refund'
      ? this.stakes.filter(tx => tx.status === 'confirmed').map(tx => this.net.send(this.number, 'pot', tx.from, tx.amount, 'Stake refund'))
      : [this.net.send(this.number, 'pot', result, 2n * STAKE, 'Winner payout')]
  }
}
