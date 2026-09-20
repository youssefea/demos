export type Side = 'player' | 'bot'
export const HIT_UNITS = 50_000n
export const MAX_IN_FLIGHT = 8
export const MATCH_LIMIT = 240 // At most 12 test USDV moved per round.
export const SESSION_LIMIT = 1_000 // At most 50 test USDV moved per page session.
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
export type Transfer = {
  id: number; victim: Side; attacker: Side; hitAt: number
  status: 'signing' | 'pending' | 'confirmed' | 'failed' | 'unknown'
  hash?: string; latency?: number; block?: number; note?: string
}
export type RawLog = { address?: string; topics?: string[]; data?: string; transactionHash?: string; blockNumber?: string | number | bigint; removed?: boolean }
export const other = (side: Side): Side => side === 'player' ? 'bot' : 'player'

/** Validate the entire event, not just a transaction hash or balance delta. */
export function matchesTransfer(log: RawLog, hash: string, token: string, from: string, to: string, amount = HIT_UNITS): boolean {
  try {
    const topic = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, '0')}`
    return log.removed !== true && log.transactionHash?.toLowerCase() === hash.toLowerCase()
      && log.address?.toLowerCase() === token.toLowerCase()
      && log.topics?.length === 3 && log.topics[0].toLowerCase() === TRANSFER_TOPIC
      && log.topics[1].toLowerCase() === topic(from) && log.topics[2].toLowerCase() === topic(to)
      && /^0x[0-9a-fA-F]{64}$/.test(log.data ?? '') && BigInt(log.data!) === amount
      && log.blockNumber !== undefined && BigInt(log.blockNumber) >= 0n
  } catch { return false }
}

export function receiptOutcome(receipt: { transactionHash?: string; status?: unknown; logs?: RawLog[] }, phasesSucceeded: boolean, hash: string, token: string, from: string, to: string): 'confirmed' | 'failed' | 'unknown' {
  if (receipt.transactionHash?.toLowerCase() !== hash.toLowerCase()) return 'unknown'
  if (['0x0', 'reverted', 0, 0n].includes(receipt.status as never) || !phasesSucceeded) return 'failed'
  if (!['0x1', 'success', 1, 1n].includes(receipt.status as never)) return 'unknown'
  return receipt.logs?.some(log => matchesTransfer(log, hash, token, from, to)) ? 'confirmed' : 'unknown'
}

export class Ledger {
  readonly transfers: Transfer[] = []
  readonly balances: Record<Side, bigint>
  matchCount = 0
  constructor(player: bigint, bot: bigint) { this.balances = { player, bot } }
  get unresolved() { return this.transfers.filter(t => ['signing', 'pending', 'unknown'].includes(t.status)) }
  get confirmed() { return this.transfers.filter(t => t.status === 'confirmed') }
  get reason(): string | null {
    if (this.transfers.some(t => t.status === 'unknown')) return 'Uncertain transaction — reconciling receipts. No new hits.'
    if (this.unresolved.length >= MAX_IN_FLIGHT) return 'Network catching up — hits safely paused.'
    if (this.matchCount >= MATCH_LIMIT) return 'Round transfer limit reached (12.00 test USDV).'
    if (this.transfers.length >= SESSION_LIMIT) return 'Session limit reached (50.00 test USDV). Reload for new test accounts.'
    return null
  }
  reserve(victim: Side, now: number): Transfer | null {
    if (this.reason) return null
    const reserved = BigInt(this.unresolved.filter(t => t.victim === victim).length) * HIT_UNITS
    if (this.balances[victim] - reserved < HIT_UNITS) return null
    const tx: Transfer = { id: this.transfers.length + 1, victim, attacker: other(victim), hitAt: now, status: 'signing' }
    this.transfers.push(tx)
    this.matchCount++
    return tx
  }
  register(id: number, hash: string) {
    const tx = this.transfers.find(t => t.id === id)
    if (!tx || tx.status !== 'signing' || this.transfers.some(t => t.hash?.toLowerCase() === hash.toLowerCase())) return false
    tx.hash = hash; tx.status = 'pending'
    return true
  }
  confirm(hash: string, block: number, now: number): Transfer | null {
    const tx = this.transfers.find(t => t.hash?.toLowerCase() === hash.toLowerCase())
    if (!tx || !['pending', 'unknown'].includes(tx.status)) return null
    tx.status = 'confirmed'; tx.block = block; tx.latency = Math.max(0, Math.round(now - tx.hitAt)); tx.note = undefined
    this.balances[tx.victim] -= HIT_UNITS
    this.balances[tx.attacker] += HIT_UNITS
    return tx
  }
  fail(id: number, note: string) {
    const tx = this.transfers.find(t => t.id === id)
    if (tx && tx.status !== 'confirmed') { tx.status = 'failed'; tx.note = note }
  }
  unknown(id: number, note: string) {
    const tx = this.transfers.find(t => t.id === id)
    if (tx && ['pending', 'signing'].includes(tx.status)) { tx.status = 'unknown'; tx.note = note }
  }
  newMatch() {
    if (this.unresolved.length || this.transfers.length >= SESSION_LIMIT) return false
    this.matchCount = 0
    return true
  }
}
export function formatUnits(amount: bigint): string {
  const sign = amount < 0n ? '−' : ''
  const value = amount < 0n ? -amount : amount
  return `${sign}${value / 1_000_000n}.${(value % 1_000_000n / 10_000n).toString().padStart(2, '0')}`
}
