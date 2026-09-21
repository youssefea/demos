import { encodeWalletCalls, keccak256, nonceKeyMax, toHex, type Hex } from '@vibenet/aa'
import { CHAIN_ID, PRIORITY_FEE } from '../../200ms-demo/src/chain/config'
import { readGenesisHash, readLatestBlock, readReceipt, sendRaw } from '../../200ms-demo/src/chain/rpc'
import { connectArenaSocket } from '../../fighter-demo/src/socket'
import { Ledger, outcome, unresolved, type Account, type Transfer } from './ledger.ts'
import { transferCalls, type Runtime } from './setup.ts'
import { ChainHead } from './head.ts'

type Signed = { raw: Hex; expires: number; lastSent: number; attempts: number; busy: boolean }
export class PredictionNetwork {
  readonly ledger: Ledger
  state = 'Connecting'; error: string | null = null
  private chainHead: ChainHead
  private lastPoll = 0; private lastGenesis = 0
  private fee: bigint; private stopped = false
  private session = crypto.randomUUID()
  private signed = new Map<number, Signed>()
  private checking = new Set<number>()
  private socket: ReturnType<typeof connectArenaSocket>
  private timer?: ReturnType<typeof setTimeout>
  constructor(readonly runtime: Runtime, private change: () => void) {
    this.ledger = new Ledger(runtime.balances); this.chainHead = new ChainHead(runtime.head); this.fee = runtime.maxFeePerGas
    this.socket = connectArenaSocket(runtime.token, Object.values(runtime.accounts).map(a => a.account.address), {
      log: log => { const tx = this.ledger.pending.find(t => t.hash?.toLowerCase() === log.transactionHash?.toLowerCase()); if (tx) void this.reconcile(tx) },
      head: head => this.onHead(head), state: state => { this.state = state; this.change() },
    })
    this.timer = setTimeout(() => void this.watch(), 0)
  }
  get head() { return this.chainHead.number }
  get blocked() { return this.error ?? (this.chainHead.stale(performance.now()) ? 'Waiting for a fresh Vibenet head.' : null) }
  send(round: number, from: Account, to: Account, amount: bigint, label: string): Transfer {
    const tx = this.ledger.create(round, from, to, amount, label, performance.now())
    if (this.stopped || this.error) { tx.status = 'failed'; tx.note = this.error ?? 'Network closed' }
    if (tx.status === 'signing') void this.sign(tx)
    this.change(); return tx
  }
  private async sign(tx: Transfer) {
    try {
      const wallet = this.runtime.accounts[tx.from], expires = Date.now() + 15_000
      const raw = await wallet.account.signTransaction({ chainId: CHAIN_ID, accountChanges: [],
        calls: encodeWalletCalls({ account: wallet.account.address, calls: transferCalls(this.runtime.token, this.runtime.accounts[tx.to].account.address, tx.amount) }),
        nonceKey: nonceKeyMax, validBefore: BigInt(expires), metadata: toHex(`predict:${this.session}:${tx.round}:${tx.id}:${expires}`),
        gas: wallet.gas, maxFeePerGas: this.fee, maxPriorityFeePerGas: PRIORITY_FEE,
      })
      if (this.stopped || this.error) throw new Error('Network stopped before broadcast')
      // Fully register before any request or websocket notification can race the response.
      this.ledger.register(tx, keccak256(raw))
      this.signed.set(tx.id, { raw, expires, lastSent: 0, attempts: 0, busy: false })
      await this.broadcast(tx)
    } catch (e) {
      if (!tx.hash) { tx.status = 'failed'; tx.note = `Signing failed: ${message(e)}` }
      else tx.note = 'Broadcast uncertain. Checking the original hash.'
    } finally { this.change() }
  }
  private async broadcast(tx: Transfer) {
    const signed = this.signed.get(tx.id)
    if (!signed || signed.busy || this.stopped || this.error || !unresolved(tx) || signed.attempts >= 4 || Date.now() >= signed.expires - 500) return
    signed.busy = true; signed.lastSent = performance.now(); signed.attempts++
    try {
      const hash = await this.socket.send(signed.raw).catch(() => sendRaw(signed.raw))
      if (hash.toLowerCase() !== tx.hash?.toLowerCase()) throw new Error('Unexpected RPC hash')
    } catch { if (unresolved(tx)) tx.note = 'Awaiting receipt. A timeout is not proof of failure.' }
    finally { signed.busy = false; this.change() }
  }
  private onHead(head: number) {
    // A delayed HTTP response may be behind WSS. Only a verified genesis change proves a reset.
    this.chainHead.observe(head, performance.now())
    this.change()
  }
  private async reconcile(tx: Transfer) {
    if (this.stopped || this.error || !tx.hash || !unresolved(tx) || this.checking.has(tx.id)) return
    this.checking.add(tx.id)
    try {
      const receipt = await readReceipt(tx.hash as Hex)
      if (receipt && !this.stopped && !this.error && unresolved(tx)) {
        const result = outcome(receipt, tx, this.runtime.token, this.runtime.accounts[tx.from].account.address, this.runtime.accounts[tx.to].account.address)
        if (result === 'confirmed') this.ledger.confirm(tx, Number(BigInt(receipt.blockNumber)), performance.now())
        else if (result === 'failed') { tx.status = 'failed'; tx.note = 'Transaction reverted; no test USDV moved.' }
        else { tx.status = 'unknown'; tx.note = 'Receipt does not prove the expected transfer. Still reconciling.' }
        if (!unresolved(tx)) this.signed.delete(tx.id)
      }
    } catch { /* No response is not a definitive failure. Keep reconciling the same hash. */ }
    finally { this.checking.delete(tx.id); this.change() }
    const signed = this.signed.get(tx.id)
    if (signed && performance.now() - signed.lastSent > 1_500) void this.broadcast(tx)
  }
  private async watch() {
    if (this.stopped) return
    const now = performance.now()
    try {
      const tasks: Promise<unknown>[] = []
      if (now - this.lastPoll > 2_000 || !this.lastPoll) {
        this.lastPoll = now
        tasks.push(readLatestBlock().then(block => { this.onHead(Number(BigInt(block.number))); this.fee = BigInt(block.baseFeePerGas ?? 1_000_000_000n) * 2n + PRIORITY_FEE }).catch(() => undefined))
      }
      if (now - this.lastGenesis > 30_000 || !this.lastGenesis) {
        this.lastGenesis = now
        tasks.push(readGenesisHash().then(hash => { if (hash.toLowerCase() !== this.runtime.genesis.toLowerCase()) this.error = 'Vibenet reset detected. Stop using these disposable accounts.' }).catch(() => undefined))
      }
      for (const tx of this.ledger.pending) {
        if (now - tx.startedAt > 25_000) { tx.status = 'unknown'; tx.note = 'Confirmation unknown. New rounds blocked; checking late receipts. Do not reload.' }
        tasks.push(this.reconcile(tx))
      }
      await Promise.all(tasks)
    } finally { this.change(); if (!this.stopped) this.timer = setTimeout(() => void this.watch(), 350) }
  }
  recheck() { for (const tx of this.ledger.pending) void this.reconcile(tx) }
  close() { this.stopped = true; clearTimeout(this.timer); this.socket.close() }
}
const message = (error: unknown) => error instanceof Error ? error.message.slice(0, 100) : 'Unknown error'
