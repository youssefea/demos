import { allPhasesSucceeded, encodeWalletCalls, keccak256, nonceKeyMax, toHex, type Hex } from '@vibenet/aa'
import { CHAIN_ID, PRIORITY_FEE } from '../../200ms-demo/src/chain/config'
import { readGenesisHash, readLatestBlock, readReceipt, sendRaw } from '../../200ms-demo/src/chain/rpc'
import { HIT_UNITS, Ledger, matchesTransfer, receiptOutcome, type RawLog, type Side, type Transfer } from './ledger'
import { transferCalls, type Runtime } from './setup'
import { connectArenaSocket } from './socket'

type Signed = { raw: Hex; expires: number; lastSent: number; busy: boolean; attempts: number }
export class ArenaNetwork {
  readonly ledger: Ledger
  head: number
  state = 'Connecting'
  error: string | null = null
  private lastHeadAt = 0
  private lastPoll = 0
  private lastGenesis = 0
  private fee: bigint
  private readonly session = crypto.randomUUID()
  private readonly signed = new Map<number, Signed>()
  private readonly reconciling = new Set<number>()
  private readonly socket: ReturnType<typeof connectArenaSocket>
  private timer?: number
  private stopped = false
  constructor(readonly runtime: Runtime, private readonly change: () => void, private readonly confirmed: (tx: Transfer) => void) {
    this.ledger = new Ledger(runtime.balances.player, runtime.balances.bot)
    this.head = runtime.head
    this.fee = runtime.maxFeePerGas
    this.socket = connectArenaSocket(runtime.token, [runtime.accounts.player.account.address, runtime.accounts.bot.account.address], {
      log: log => this.onLog(log),
      head: head => this.onHead(head),
      state: state => { this.state = state; this.change() },
    })
    this.timer = window.setTimeout(() => void this.watch(), 0)
  }
  get blocked(): string | null {
    return this.error ?? this.ledger.reason ?? (performance.now() - this.lastHeadAt > 8_000 || this.lastHeadAt === 0 ? 'Waiting for a fresh network head. Combat paused.' : null)
  }
  hit(victim: Side): boolean {
    if (this.stopped || this.blocked) return false
    const tx = this.ledger.reserve(victim, performance.now())
    if (!tx) { this.error = 'Insufficient test USDV. No new hits will be sent.'; this.change(); return false }
    this.change()
    void this.sign(tx)
    return true
  }
  private async sign(tx: Transfer) {
    let registered = false
    try {
      const fighter = this.runtime.accounts[tx.victim]
      const expires = Date.now() + 15_000
      const raw = await fighter.account.signTransaction({
        chainId: CHAIN_ID, accountChanges: [],
        calls: encodeWalletCalls({ account: fighter.account.address, calls: transferCalls(this.runtime.token, this.runtime.accounts[tx.attacker].account.address, HIT_UNITS) }),
        nonceKey: nonceKeyMax, validBefore: BigInt(expires),
        metadata: toHex(`block-fighter:${this.session}:${tx.id}:${expires}`),
        gas: fighter.gas, maxFeePerGas: this.fee, maxPriorityFeePerGas: PRIORITY_FEE,
      })
      if (this.stopped) { this.ledger.fail(tx.id, 'Page closed before broadcast'); return }
      const hash = keccak256(raw)
      // Critical: the complete expected transfer is registered BEFORE any RPC broadcast.
      if (!this.ledger.register(tx.id, hash)) throw new Error('Could not register unique transaction')
      registered = true
      this.signed.set(tx.id, { raw, expires, lastSent: 0, busy: false, attempts: 0 })
      this.change()
      await this.broadcast(tx)
    } catch (error) {
      if (!registered) this.ledger.fail(tx.id, `Signing failed: ${message(error)}`)
      else tx.note = `Broadcast uncertain: ${message(error)}`
      this.change()
    }
  }
  private async broadcast(tx: Transfer) {
    const signed = this.signed.get(tx.id)
    if (!signed || signed.busy || this.stopped || tx.status === 'confirmed' || tx.status === 'failed' || Date.now() >= signed.expires - 500) return
    signed.busy = true; signed.lastSent = performance.now(); signed.attempts++
    try {
      const returned = await this.socket.send(signed.raw).catch(() => sendRaw(signed.raw))
      if (returned.toLowerCase() !== tx.hash?.toLowerCase()) throw new Error('RPC returned an unexpected hash')
    } catch (error) {
      // A timeout/rejection after submission is NOT proof of failure. Never create replacement transfers.
      if (tx.status === 'pending') tx.note = `Awaiting receipt · ${message(error)}`
    } finally { signed.busy = false; this.change() }
  }
  private onHead(head: number) {
    if (head < this.head - 8) this.error = 'Vibenet reset detected. Reload to create new test accounts.'
    if (head > this.head) { this.head = head; this.lastHeadAt = performance.now() }
    this.change()
  }
  private onLog(log: RawLog) {
    if (!log || this.error?.includes('reset')) return
    const tx = this.ledger.transfers.find(t => t.hash?.toLowerCase() === log.transactionHash?.toLowerCase())
    if (!tx?.hash) return
    if (matchesTransfer(log, tx.hash, this.runtime.token, this.runtime.accounts[tx.victim].account.address, this.runtime.accounts[tx.attacker].account.address)) {
      this.confirm(tx, Number(BigInt(log.blockNumber!)))
    }
  }
  private confirm(tx: Transfer, block: number) {
    const result = this.ledger.confirm(tx.hash!, block, performance.now())
    if (result) { this.signed.delete(tx.id); this.confirmed(result); this.change() }
  }
  private async reconcile(tx: Transfer) {
    if (this.stopped || !tx.hash || this.error?.includes('reset') || this.reconciling.has(tx.id)) return
    this.reconciling.add(tx.id)
    try {
      const receipt = await readReceipt(tx.hash as Hex)
      if (receipt && !this.stopped) {
        const outcome = receiptOutcome(receipt, allPhasesSucceeded(receipt.eip8130 ?? receipt), tx.hash, this.runtime.token, this.runtime.accounts[tx.victim].account.address, this.runtime.accounts[tx.attacker].account.address)
        if (outcome === 'confirmed') this.confirm(tx, Number(BigInt(receipt.blockNumber)))
        else if (outcome === 'failed') { this.ledger.fail(tx.id, 'Transaction reverted. No USDV credited.'); this.signed.delete(tx.id) }
        else this.ledger.unknown(tx.id, 'Receipt has no validated USDV transfer. No balance change; reconciliation continues.')
      }
    } catch { /* RPC downtime must never look like a confirmation or a definitive failure. */ }
    finally { this.reconciling.delete(tx.id) }
    const signed = this.signed.get(tx.id)
    if (signed && signed.attempts < 4 && performance.now() - signed.lastSent > 1_500) void this.broadcast(tx)
  }
  private async watch() {
    if (this.stopped) return
    try {
      const now = performance.now()
      if (now - this.lastPoll > 3_000 || this.lastPoll === 0) {
        this.lastPoll = now
        try {
          const block = await readLatestBlock()
          this.onHead(Number(BigInt(block.number)))
          this.fee = BigInt(block.baseFeePerGas ?? 1_000_000_000n) * 2n + PRIORITY_FEE
        } catch { /* Freshness guard stops combat if both transports are unavailable. */ }
      }
      if (now - this.lastGenesis > 30_000) {
        this.lastGenesis = now
        try {
          if ((await readGenesisHash()).toLowerCase() !== this.runtime.genesis.toLowerCase()) this.error = 'Vibenet reset detected. Reload to create new test accounts.'
        } catch { /* Retry on the next check. */ }
      }
      for (const tx of this.ledger.unresolved) {
        if (performance.now() - tx.hitAt > 25_000) this.ledger.unknown(tx.id, 'Confirmation unknown. Funds unchanged; checking late receipts. Do not assume this failed.')
      }
      await Promise.all(this.ledger.unresolved.filter(t => now - t.hitAt > 1_200).map(t => this.reconcile(t)))
    } finally {
      this.change()
      if (!this.stopped) this.timer = window.setTimeout(() => void this.watch(), this.ledger.unresolved.some(t => t.status === 'unknown') ? 3_000 : 700)
    }
  }
  retry() { this.lastPoll = 0; void Promise.all(this.ledger.unresolved.map(tx => this.reconcile(tx))) }
  close() { this.stopped = true; clearTimeout(this.timer); this.socket.close() }
}
const message = (error: unknown) => error instanceof Error ? error.message.slice(0, 150) : 'Network error'
