import {
  canonicalAuthenticators, encodeFunctionData, encodeWalletCalls, key, newSmartAccount,
  nonceFreeCost, nonceKeyExistingCost, privateKeyToAccount, type Address, type Hex,
} from '@vibenet/aa'
import { CHAIN_ID, erc20Abi, MIN_ETH_BOOTSTRAP, PRIORITY_FEE } from '../../200ms-demo/src/chain/config.ts'
import { STAKE, type Account } from './ledger.ts'
import { fundingEstimate, type SetupPhase, type SetupProgress } from './loading.ts'
export const transferCalls = (token: Address, recipient: Address, amount: bigint) => [[{
  to: token, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [recipient, amount] }),
}]] as const
export type Wallet = { account: ReturnType<typeof newSmartAccount>; signer: ReturnType<typeof privateKeyToAccount>; gas: bigint }
export type Runtime = { accounts: Record<Account, Wallet>; balances: Record<Account, bigint>; token: Address; genesis: Hex; head: number; maxFeePerGas: bigint }

/** A fresh recipient receives 0.02 ETH before deployment, enough for the capped test session. */
export const RECIPIENT_GAS_TARGET = 20_000_000_000_000_000n
export const DONOR_GAS_RESERVE = 20_000_000_000_000_000n
const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

type FaucetLike = {
  ensureEth(address: Address, minimum: bigint): Promise<Hex | null>
  ensureUsdv(address: Address, minimum: bigint): Promise<Hex | null>
}
export type SetupReceipt = { status?: unknown; eip8130?: { phaseStatuses?: unknown[] }; phaseStatuses?: unknown[] }
export type SetupStatus = {
  chain_id: number; usdv_address: Address; ip_cooldown_secs: number; addr_cooldown_secs: number
  drip_wei: string; balance_wei: string; usdv_drip_units: string; address: Address
}
export type SetupDependencies = {
  now(): number
  sleep(ms: number): Promise<void>
  confirmationTimeoutMs: number
  balanceTimeoutMs: number
  getChainHealth(): Promise<{ healthy: boolean }>
  getContracts(): Promise<any>
  getFaucetStatus(): Promise<SetupStatus>
  readGenesisHash(): Promise<Hex>
  chainId(): Promise<string>
  resolveImplementation(contracts: any): Promise<Address | null | undefined>
  resolveToken(contracts: any, faucetToken: Address): Address
  readCode(address: Address): Promise<Hex>
  readEthBalance(address: Address): Promise<bigint>
  readTokenBalance(token: Address, address: Address): Promise<bigint>
  readLatestBlock(): Promise<{ number: Hex; hash: Hex; baseFeePerGas?: Hex }>
  makeWallet(implementation: Address): Wallet
  makeFaucet(status: SetupStatus, token: Address): FaucetLike
  transactionCount(address: Address): Promise<bigint>
  estimate(parameters: any): Promise<bigint>
  readReceipt(hash: Hex): Promise<SetupReceipt | null>
  sendRaw(raw: Hex): Promise<Hex>
  hash(raw: Hex): Hex
  phaseSucceeded(receipt: SetupReceipt): boolean
}

const unavailable = () => Promise.reject(new Error('Setup dependency unavailable'))
const dependencies: SetupDependencies = {
  now: () => Date.now(), sleep: defaultSleep, confirmationTimeoutMs: 60_000, balanceTimeoutMs: 15_000,
  getChainHealth: unavailable, getContracts: unavailable, getFaucetStatus: unavailable, readGenesisHash: unavailable,
  chainId: unavailable, resolveImplementation: unavailable, resolveToken: () => { throw new Error('Setup dependency unavailable') },
  readCode: unavailable, readEthBalance: unavailable, readTokenBalance: unavailable, readLatestBlock: unavailable,
  makeWallet: () => { throw new Error('Setup dependency unavailable') }, makeFaucet: () => { throw new Error('Setup dependency unavailable') },
  transactionCount: unavailable, estimate: unavailable, readReceipt: unavailable, sendRaw: unavailable,
  hash: raw => raw,
  phaseSucceeded: receipt => {
    const status = receipt.status
    if (!['0x1', 'success', 1, 1n].includes(status as never)) return false
    const fields = receipt.eip8130 ?? receipt
    const statuses = fields.phaseStatuses
    return Array.isArray(statuses) && statuses.length === 1 && ['0x1', '0x01'].includes(String(statuses[0]))
  },
}

type Distribution = { raw: Hex; hash: Hex; expected: Partial<Record<'jev' | 'pot', bigint>>; balancesVerified?: boolean }
type ProgressListener = (label: string, stage?: SetupProgress) => void

export class Setup {
  private readonly deps: SetupDependencies
  private prepared?: { accounts: Record<Account, Wallet>; genesis: Hex; token: Address; implementation: Address }
  // Signed bytes survive retries: an RPC timeout must never cause a replacement transaction.
  private deployments = new Map<Account, Hex>()
  private distribution?: Distribution
  private running?: Promise<Runtime>
  private listeners = new Set<ProgressListener>()

  constructor(overrides: Partial<SetupDependencies> = {}) {
    this.deps = { ...dependencies, ...overrides }
  }

  run(progress: ProgressListener): Promise<Runtime> {
    this.listeners.add(progress)
    if (this.running) return this.running
    const wrapped = this.execute().finally(() => {
      this.running = undefined
      this.listeners.clear()
    })
    this.running = wrapped
    return wrapped
  }

  private report(phase: SetupPhase, detail: string, remainingSeconds?: number) {
    const stage = { phase, detail, remainingSeconds, at: this.deps.now() }
    for (const listener of this.listeners) listener(detail, stage)
  }

  private async execute(): Promise<Runtime> {
    const d = this.deps
    this.report('connect', 'Checking the network and finding the test contracts…')
    const [health, contracts, status, genesis, chain] = await Promise.all([
      d.getChainHealth(), d.getContracts(), d.getFaucetStatus(), d.readGenesisHash(), d.chainId(),
    ])
    if (!health.healthy) throw new Error('Vibenet is unavailable. Please try again later.')
    if (Number(BigInt(chain)) !== CHAIN_ID || status.chain_id !== CHAIN_ID) throw new Error('Unexpected chain. No signing or funding allowed.')
    const implementation = await d.resolveImplementation(contracts)
    const token = d.resolveToken(contracts, status.usdv_address)
    if (!implementation || !/^0x[0-9a-f]{40}$/i.test(token) || await d.readCode(token) === '0x') throw new Error('Test account or USDV contract unavailable.')
    const cooldown = Math.max(status.ip_cooldown_secs, status.addr_cooldown_secs)
    this.report('accounts', 'Creating or recovering three disposable smart wallets…', fundingEstimate(3, cooldown))
    if (!this.prepared || this.prepared.genesis !== genesis || this.prepared.token !== token || this.prepared.implementation !== implementation) {
      this.prepared = { accounts: { player: d.makeWallet(implementation), jev: d.makeWallet(implementation), pot: d.makeWallet(implementation) }, token, genesis, implementation }
      this.deployments.clear()
      this.distribution = undefined
    }
    const { accounts } = this.prepared
    const faucet = d.makeFaucet(status, token)
    let funded = 0
    this.report('funding', `Your wallet: getting test gas · ${funded}/3 faucet checks complete`, fundingEstimate(3 - funded, cooldown))
    await faucet.ensureEth(accounts.player.account.address, MIN_ETH_BOOTSTRAP)
    funded++
    for (const side of ['player', 'jev'] as const) {
      this.report('funding', `${side === 'player' ? 'Your wallet' : 'Jev’s wallet'}: getting test coins · ${funded}/3 faucet checks complete`, fundingEstimate(3 - funded, cooldown))
      await faucet.ensureUsdv(accounts[side].account.address, 20n * STAKE)
      funded++
    }
    this.report('funding', 'All three faucet checks complete. Gas and test coins received.', 18)

    const block = await d.readLatestBlock()
    const maxFeePerGas = BigInt(block.baseFeePerGas ?? 1_000_000_000n) * 2n + PRIORITY_FEE
    await this.deploy(accounts, 'player', token, maxFeePerGas, 0)
    await this.distributeGas(accounts, maxFeePerGas)
    await this.deploy(accounts, 'jev', token, maxFeePerGas, 1)
    await this.deploy(accounts, 'pot', token, maxFeePerGas, 2)

    this.report('verify', 'Wallets deployed. Reading the final onchain balances…', 5)
    const [player, jev, pot, playerEth, jevEth, potEth] = await Promise.all([
      d.readTokenBalance(token, accounts.player.account.address),
      d.readTokenBalance(token, accounts.jev.account.address),
      d.readTokenBalance(token, accounts.pot.account.address),
      d.readEthBalance(accounts.player.account.address),
      d.readEthBalance(accounts.jev.account.address),
      d.readEthBalance(accounts.pot.account.address),
    ])
    if (pot !== 0n) throw new Error('Unexpected nonempty test pot. Reload before playing.')
    if (playerEth < MIN_ETH_BOOTSTRAP || jevEth < MIN_ETH_BOOTSTRAP || potEth < MIN_ETH_BOOTSTRAP) {
      throw new Error('Setup gas reserve is below the safe minimum. Reload with a funded faucet.')
    }
    return { accounts, balances: { player, jev, pot }, token, genesis, head: Number(BigInt(block.number)), maxFeePerGas }
  }

  private base(wallet: Wallet) {
    const actor = key.k1(wallet.signer.address)
    return { sender: wallet.account.address, senderActorId: actor.actorId, senderAuthAuthenticator: canonicalAuthenticators.k1, nonceKey: 0n }
  }

  private async deploy(accounts: Record<Account, Wallet>, side: Account, token: Address, maxFeePerGas: bigint, index: number) {
    const d = this.deps
    this.report('deploy', `Deploying and checking ${side === 'player' ? 'your wallet' : side === 'jev' ? 'Jev’s wallet' : 'the pot'} · ${index}/3 wallets ready`, (3 - index) * 4 + 7)
    const wallet = accounts[side]
    const sender = wallet.account.address
    let sequence = await d.transactionCount(sender)
    const base = this.base(wallet)
    let raw = this.deployments.get(side)
    if (raw || await d.readCode(sender) === '0x') {
      if (!raw) {
        const calls = transferCalls(token, sender, 0n)
        const gas = await d.estimate({ ...base, nonceSequence: Number(sequence), accountChanges: [wallet.account.createChange], calls })
        raw = await wallet.account.signTransaction({
          chainId: CHAIN_ID, accountChanges: [wallet.account.createChange], calls: encodeWalletCalls({ account: sender, calls }),
          nonceKey: 0n, nonceSequence: sequence, maxFeePerGas, maxPriorityFeePerGas: PRIORITY_FEE, gas: (gas * 13n + 9n) / 10n,
        })
        this.deployments.set(side, raw)
      }
      await this.confirm(raw, `Account deployment failed: ${d.hash(raw)}`, 'Account deployment unconfirmed. Retry checks identical signed bytes.')
      sequence = await d.transactionCount(sender)
    }
    await this.waitFor(async () => (await d.readCode(sender)) !== '0x', 'Smart account code is not yet readable. Retry setup.')
    const calls = transferCalls(token, accounts[side === 'player' ? 'jev' : 'player'].account.address, side === 'pot' ? 0n : STAKE)
    const estimate = await d.estimate({ ...base, nonceSequence: Number(sequence), accountChanges: [], calls })
    wallet.gas = ((estimate + nonceFreeCost - nonceKeyExistingCost + 50_000n) * 13n + 9n) / 10n
  }

  private async distributeGas(accounts: Record<Account, Wallet>, maxFeePerGas: bigint) {
    const d = this.deps
    const player = accounts.player
    this.report('deploy', 'Sharing the single gas drip with Jev and the pot…', 15)
    if (this.distribution) {
      await this.confirm(this.distribution.raw, `Gas distribution failed: ${this.distribution.hash}`, 'Gas distribution unconfirmed. Retry checks identical signed bytes.')
      // Verified recipients may already have spent gas on their deployments.
      if (!this.distribution.balancesVerified) await this.waitForDistribution(accounts, this.distribution.expected)
      this.distribution.balancesVerified = true
      return
    }

    const [jevBalance, potBalance] = await Promise.all([
      d.readEthBalance(accounts.jev.account.address), d.readEthBalance(accounts.pot.account.address),
    ])
    const amounts = {
      jev: jevBalance < RECIPIENT_GAS_TARGET ? RECIPIENT_GAS_TARGET - jevBalance : 0n,
      pot: potBalance < RECIPIENT_GAS_TARGET ? RECIPIENT_GAS_TARGET - potBalance : 0n,
    }
    if (amounts.jev === 0n && amounts.pot === 0n) return
    const calls = [[
      ...(amounts.jev ? [{ to: accounts.jev.account.address, value: amounts.jev, data: '0x' as Hex }] : []),
      ...(amounts.pot ? [{ to: accounts.pot.account.address, value: amounts.pot, data: '0x' as Hex }] : []),
    ]] as const
    // Estimate the exact wallet-wrapped batch that will be signed, including native-value execution.
    const encodedCalls = encodeWalletCalls({ account: player.account.address, calls })
    const sequence = await d.transactionCount(player.account.address)
    const base = this.base(player)
    const estimate = await d.estimate({ ...base, nonceSequence: Number(sequence), accountChanges: [], calls: encodedCalls })
    const gas = (estimate * 13n + 9n) / 10n
    const donorBalance = await d.readEthBalance(player.account.address)
    const value = amounts.jev + amounts.pot
    const required = value + gas * maxFeePerGas + DONOR_GAS_RESERVE
    if (donorBalance < required) {
      throw new Error(`One gas faucet drip is insufficient for safe setup (need ${required} wei, have ${donorBalance} wei).`)
    }
    const raw = await player.account.signTransaction({
      chainId: CHAIN_ID, accountChanges: [], calls: encodedCalls,
      nonceKey: 0n, nonceSequence: sequence, maxFeePerGas, maxPriorityFeePerGas: PRIORITY_FEE, gas,
    })
    const expected = {
      ...(amounts.jev ? { jev: jevBalance + amounts.jev } : {}),
      ...(amounts.pot ? { pot: potBalance + amounts.pot } : {}),
    }
    this.distribution = { raw, hash: d.hash(raw), expected }
    await this.confirm(raw, `Gas distribution failed: ${this.distribution.hash}`, 'Gas distribution unconfirmed. Retry checks identical signed bytes.')
    await this.waitForDistribution(accounts, expected)
    this.distribution.balancesVerified = true
  }

  private async waitForDistribution(accounts: Record<Account, Wallet>, expected: Distribution['expected']) {
    await this.waitFor(async () => {
      const checks = await Promise.all((['jev', 'pot'] as const).filter(side => expected[side] !== undefined).map(async side =>
        (await this.deps.readEthBalance(accounts[side].account.address)) >= expected[side]!,
      ))
      return checks.every(Boolean)
    }, 'Gas distribution confirmed but recipient balances did not arrive. Setup remains blocked.')
  }

  private async confirm(raw: Hex, failed: string, timeout: string) {
    const d = this.deps
    const hash = d.hash(raw)
    const deadline = d.now() + d.confirmationTimeoutMs
    let lastSent = 0
    while (d.now() < deadline) {
      const receipt = await d.readReceipt(hash)
      if (receipt) {
        if (!d.phaseSucceeded(receipt)) throw new Error(failed)
        return
      }
      if (d.now() - lastSent > 1_500 || lastSent === 0) {
        lastSent = d.now() || 1
        await d.sendRaw(raw).catch(() => undefined)
      }
      await d.sleep(350)
    }
    throw new Error(timeout)
  }

  private async waitFor(check: () => Promise<boolean>, message: string) {
    const deadline = this.deps.now() + this.deps.balanceTimeoutMs
    while (this.deps.now() < deadline) {
      try { if (await check()) return } catch { /* lagging replicas are retried */ }
      await this.deps.sleep(350)
    }
    throw new Error(message)
  }
}
