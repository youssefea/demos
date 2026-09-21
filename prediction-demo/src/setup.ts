import {
  allPhasesSucceeded, canonicalAuthenticators, encodeWalletCalls, estimateGas, generatePrivateKey,
  getTransactionCount, key, keccak256, newSmartAccount, nonceFreeCost, nonceKeyExistingCost, privateKeyToAccount, type Address, type Hex,
} from '@vibenet/aa'
import { resolveHighRateImplementation, resolveUsdv } from '../../200ms-demo/src/chain/account'
import { CHAIN_ID, MIN_ETH_BOOTSTRAP, PRIORITY_FEE } from '../../200ms-demo/src/chain/config'
import { FaucetQueue } from '../../200ms-demo/src/chain/faucet'
import { getChainHealth, getContracts, getFaucetStatus, publicClient, readCode, readGenesisHash, readLatestBlock, readReceipt, readTokenBalance, rpc, sendRaw } from '../../200ms-demo/src/chain/rpc'
import { transferCalls } from '../../fighter-demo/src/setup'
import { STAKE, type Account } from './ledger.ts'
import { fundingEstimate, type SetupPhase, type SetupProgress } from './loading.ts'
export { transferCalls }
export type Wallet = { account: ReturnType<typeof newSmartAccount>; signer: ReturnType<typeof privateKeyToAccount>; gas: bigint }
export type Runtime = { accounts: Record<Account, Wallet>; balances: Record<Account, bigint>; token: Address; genesis: Hex; head: number; maxFeePerGas: bigint }
const sides = ['player', 'jev', 'pot'] as const
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const make = (implementation: Address): Wallet => {
  const signer = privateKeyToAccount(generatePrivateKey())
  return { signer, account: newSmartAccount({ signer, implementation, salt: generatePrivateKey() }), gas: 0n }
}
export class Setup {
  private prepared?: { accounts: Record<Account, Wallet>; genesis: Hex; token: Address; implementation: Address }
  // Keep signed deployment bytes across setup retries, too. An RPC timeout is not a failed deployment.
  private deployments = new Map<Account, Hex>()
  async run(progress: (label: string, stage?: SetupProgress) => void): Promise<Runtime> {
    const report = (phase: SetupPhase, detail: string, remainingSeconds?: number) => progress(detail, { phase, detail, remainingSeconds, at: Date.now() })
    report('connect', 'Checking the network and finding the test contracts…')
    const [health, contracts, status, genesis, chain] = await Promise.all([getChainHealth(), getContracts(), getFaucetStatus(), readGenesisHash(), rpc<string>('eth_chainId')])
    if (!health.healthy) throw new Error('Vibenet is unavailable. Please try again later.')
    if (Number(BigInt(chain)) !== CHAIN_ID || status.chain_id !== CHAIN_ID) throw new Error('Unexpected chain. No signing or funding allowed.')
    const implementation = await resolveHighRateImplementation(contracts), token = resolveUsdv(contracts, status.usdv_address)
    if (!implementation || !/^0x[0-9a-f]{40}$/i.test(token) || await readCode(token) === '0x') throw new Error('Test account or USDV contract unavailable.')
    report('accounts', 'Creating or recovering three disposable smart wallets…', fundingEstimate(5, Math.max(status.ip_cooldown_secs, status.addr_cooldown_secs)))
    if (!this.prepared || this.prepared.genesis !== genesis || this.prepared.token !== token || this.prepared.implementation !== implementation) {
      this.prepared = { accounts: { player: make(implementation), jev: make(implementation), pot: make(implementation) }, token, genesis, implementation }
      this.deployments.clear()
    }
    const { accounts } = this.prepared
    const faucet = new FaucetQueue(status, token)
    let funded = 0
    const cooldown = Math.max(status.ip_cooldown_secs, status.addr_cooldown_secs)
    for (const side of sides) {
      report('funding', `${side === 'player' ? 'Your wallet' : side === 'jev' ? 'Jev’s wallet' : 'The pot'}: getting test gas · ${funded}/5 funding checks complete`, fundingEstimate(5 - funded, cooldown))
      await faucet.ensureEth(accounts[side].account.address, MIN_ETH_BOOTSTRAP)
      funded++
      if (side !== 'pot') {
        report('funding', `${side === 'player' ? 'Your wallet' : 'Jev’s wallet'}: getting test coins · ${funded}/5 funding checks complete`, fundingEstimate(5 - funded, cooldown))
        await faucet.ensureUsdv(accounts[side].account.address, 20n * STAKE)
        funded++
      }
    }
    report('funding', 'All five funding checks complete. Gas and test coins received.', 12)
    const block = await readLatestBlock(), maxFeePerGas = BigInt(block.baseFeePerGas ?? 1_000_000_000n) * 2n + PRIORITY_FEE
    for (const side of sides) {
      report('deploy', `Deploying and checking ${side === 'player' ? 'your wallet' : side === 'jev' ? 'Jev’s wallet' : 'the pot'} · ${sides.indexOf(side)}/3 wallets ready`, (3 - sides.indexOf(side)) * 4 + 3)
      const wallet = accounts[side], sender = wallet.account.address
      let sequence = await getTransactionCount(publicClient, { address: sender, nonceKey: 0n })
      const actor = key.k1(wallet.signer.address)
      const base = { sender, senderActorId: actor.actorId, senderAuthAuthenticator: canonicalAuthenticators.k1, nonceKey: 0n }
      if (await readCode(sender) === '0x') {
        let raw = this.deployments.get(side)
        if (!raw) {
          const calls = transferCalls(token, sender, 0n)
          const gas = await estimateGas(publicClient, { ...base, nonceSequence: Number(sequence), accountChanges: [wallet.account.createChange], calls })
          raw = await wallet.account.signTransaction({ chainId: CHAIN_ID, accountChanges: [wallet.account.createChange], calls: encodeWalletCalls({ account: sender, calls }), nonceKey: 0n, nonceSequence: sequence, maxFeePerGas, maxPriorityFeePerGas: PRIORITY_FEE, gas: (gas * 13n + 9n) / 10n })
          this.deployments.set(side, raw)
        }
        const hash = keccak256(raw), deadline = Date.now() + 60_000
        let confirmed = false, lastSent = 0
        while (Date.now() < deadline) {
          const receipt = await readReceipt(hash)
          if (receipt) {
            if (!['0x1', 'success', 1, 1n].includes(receipt.status as never) || !allPhasesSucceeded(receipt.eip8130 ?? receipt)) throw new Error(`Account deployment failed: ${hash}`)
            confirmed = true; break
          }
          if (Date.now() - lastSent > 1_500) { lastSent = Date.now(); await sendRaw(raw).catch(() => undefined) }
          await sleep(350)
        }
        if (!confirmed) throw new Error('Account deployment unconfirmed. Retry checks identical signed bytes.')
        sequence++
      }
      if (await readCode(sender) === '0x') throw new Error('Smart account code is not yet readable. Retry setup.')
      // A zero transfer can be estimated for the empty pot. Nonzero execution adds at most an ERC20 storage write;
      // use a generous floor plus the SDK nonce-free surcharge, not a failing spend from an empty account.
      const calls = transferCalls(token, accounts[side === 'player' ? 'jev' : 'player'].account.address, side === 'pot' ? 0n : STAKE)
      const estimate = await estimateGas(publicClient, { ...base, nonceSequence: Number(sequence), accountChanges: [], calls })
      wallet.gas = ((estimate + nonceFreeCost - nonceKeyExistingCost + 50_000n) * 13n + 9n) / 10n
    }
    report('verify', 'Wallets deployed. Reading the final onchain balances…', 5)
    const balances = { player: await readTokenBalance(token, accounts.player.account.address), jev: await readTokenBalance(token, accounts.jev.account.address), pot: await readTokenBalance(token, accounts.pot.account.address) }
    if (balances.pot !== 0n) throw new Error('Unexpected nonempty test pot. Reload before playing.')
    return { accounts, balances, token, genesis, head: Number(BigInt(block.number)), maxFeePerGas }
  }
}
