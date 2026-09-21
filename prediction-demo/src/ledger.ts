import { matchesTransfer, type RawLog } from '../../fighter-demo/src/ledger.ts'
export { formatUnits } from '../../fighter-demo/src/ledger.ts'
export type Account = 'player' | 'jev' | 'pot'
export const STAKE = 1_000_000n
export type Transfer = {
  id: number; round: number; from: Account; to: Account; amount: bigint; label: string; startedAt: number
  status: 'signing' | 'pending' | 'confirmed' | 'failed' | 'unknown'; hash?: string; note?: string; latency?: number; block?: number
}
export const unresolved = (tx: Transfer) => ['signing', 'pending', 'unknown'].includes(tx.status)
type Receipt = { transactionHash?: string; status?: unknown; logs?: RawLog[]; phaseStatuses?: unknown; eip8130?: { phaseStatuses?: unknown } }
const succeeded = (value: unknown) => ['0x1', '0x01', 'success', 1, 1n].includes(value as never)
const reverted = (value: unknown) => ['0x0', '0x00', 'reverted', 0, 0n].includes(value as never)
/** Round transfers contain exactly one call phase. Missing/unknown AA metadata is not a revert. */
export function phaseOutcome(receipt: Receipt): 'confirmed' | 'failed' | 'unknown' {
  const phases = receipt.eip8130?.phaseStatuses ?? receipt.phaseStatuses
  if (!Array.isArray(phases) || phases.length !== 1) return 'unknown'
  return succeeded(phases[0]) ? 'confirmed' : reverted(phases[0]) ? 'failed' : 'unknown'
}
export function outcome(receipt: Receipt, tx: Transfer, token: string, from: string, to: string): 'confirmed' | 'failed' | 'unknown' {
  if (!tx.hash || receipt.transactionHash?.toLowerCase() !== tx.hash.toLowerCase()) return 'unknown'
  const phase = phaseOutcome(receipt)
  if (reverted(receipt.status) || phase === 'failed') return 'failed'
  if (!succeeded(receipt.status) || phase !== 'confirmed') return 'unknown'
  return receipt.logs?.some(log => matchesTransfer(log, tx.hash!, token, from, to, tx.amount)) ? 'confirmed' : 'unknown'
}
export class Ledger {
  transfers: Transfer[] = []
  balances: Record<Account, bigint>
  constructor(balances: Record<Account, bigint>) { this.balances = { ...balances } }
  get pending() { return this.transfers.filter(unresolved) }
  create(round: number, from: Account, to: Account, amount: bigint, label: string, now: number): Transfer {
    const tx: Transfer = { id: this.transfers.length + 1, round, from, to, amount, label, startedAt: now, status: 'signing' }
    const reserved = this.pending.filter(t => t.from === from).reduce((sum, t) => sum + t.amount, 0n)
    if (amount <= 0n || this.balances[from] - reserved < amount) { tx.status = 'failed'; tx.note = 'Insufficient confirmed test USDV.' }
    this.transfers.push(tx)
    return tx
  }
  register(tx: Transfer, hash: string) {
    if (tx.status !== 'signing' || this.transfers.some(t => t.hash?.toLowerCase() === hash.toLowerCase())) throw new Error('Duplicate or invalid transaction')
    tx.hash = hash; tx.status = 'pending'
  }
  confirm(tx: Transfer, block: number, now: number) {
    if (!tx.hash || !['pending', 'unknown'].includes(tx.status)) return false
    tx.status = 'confirmed'; tx.note = undefined; tx.block = block; tx.latency = Math.max(0, Math.round(now - tx.startedAt))
    this.balances[tx.from] -= tx.amount; this.balances[tx.to] += tx.amount
    return true
  }
}
