import {
  allPhasesSucceeded, canonicalAuthenticators, encodeFunctionData, encodeWalletCalls, estimateGas,
  generatePrivateKey, getTransactionCount, key, keccak256, newSmartAccount, nonceFreeCost,
  nonceKeyExistingCost, privateKeyToAccount, type Address, type Hex,
} from '@vibenet/aa'
import { resolveHighRateImplementation, resolveUsdv } from '../../200ms-demo/src/chain/account'
import { CHAIN_ID, erc20Abi, MIN_ETH_BOOTSTRAP, PRIORITY_FEE } from '../../200ms-demo/src/chain/config'
import { FaucetQueue } from '../../200ms-demo/src/chain/faucet'
import { getChainHealth, getContracts, getFaucetStatus, publicClient, readCode, readGenesisHash, readLatestBlock, readReceipt, readTokenBalance, rpc, sendRaw } from '../../200ms-demo/src/chain/rpc'
import { type Side } from './ledger'

export type FighterAccount = { account: ReturnType<typeof newSmartAccount>; signer: ReturnType<typeof privateKeyToAccount>; gas: bigint }
export type Runtime = {
  accounts: Record<Side, FighterAccount>; token: Address; genesis: Hex; head: number
  balances: Record<Side, bigint>; maxFeePerGas: bigint
}
const sleep = (ms: number) => new Promise(resolve => window.setTimeout(resolve, ms))
const makeAccount = (implementation: Address): FighterAccount => {
  const signer = privateKeyToAccount(generatePrivateKey())
  return { signer, account: newSmartAccount({ signer, implementation, salt: generatePrivateKey() }), gas: 0n }
}
export const transferCalls = (token: Address, recipient: Address, amount: bigint) => [[{
  to: token, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [recipient, amount] }),
}]] as const

// Keys are memory-only, never shared with 200ms-demo or another tab. Partial setup retries reuse them.
export class Setup {
  private prepared?: { accounts: Record<Side, FighterAccount>; genesis: Hex; implementation: Address; token: Address }
  async run(progress: (label: string) => void): Promise<Runtime> {
    progress('Checking Vibenet & discovering live contracts…')
    const [health, contracts, faucetStatus, genesis, chain] = await Promise.all([
      getChainHealth(), getContracts(), getFaucetStatus(), readGenesisHash(), rpc<string>('eth_chainId'),
    ])
    if (!health.healthy) throw new Error(`Vibenet is unavailable: ${health.reason ?? health.detail ?? 'health check failed'}`)
    if (Number(BigInt(chain)) !== CHAIN_ID || faucetStatus.chain_id !== CHAIN_ID) throw new Error('Unexpected chain. Refusing to fund or sign.')
    const implementation = await resolveHighRateImplementation(contracts)
    const token = resolveUsdv(contracts, faucetStatus.usdv_address)
    if (!implementation || !/^0x[0-9a-f]{40}$/i.test(token) || await readCode(token) === '0x') throw new Error('Live account or USDV contract unavailable.')
    if (!this.prepared || this.prepared.genesis !== genesis || this.prepared.implementation !== implementation || this.prepared.token !== token) {
      this.prepared = { accounts: { player: makeAccount(implementation), bot: makeAccount(implementation) }, genesis, implementation, token }
    }
    const { accounts } = this.prepared
    const faucet = new FaucetQueue(faucetStatus, token)
    for (const side of ['player', 'bot'] as const) {
      const label = side === 'player' ? 'Your fighter' : 'Sparring bot'
      progress(`${label}: funding test gas · faucet cooldown ${Math.max(faucetStatus.ip_cooldown_secs, faucetStatus.addr_cooldown_secs)}s between drips…`)
      await faucet.ensureEth(accounts[side].account.address, MIN_ETH_BOOTSTRAP)
      progress(`${label}: funding test USDV · waiting for faucet / balance confirmation…`)
      await faucet.ensureUsdv(accounts[side].account.address, 50_000_000n)
    }
    const block = await readLatestBlock()
    const maxFeePerGas = BigInt(block.baseFeePerGas ?? 1_000_000_000n) * 2n + PRIORITY_FEE
    for (const side of ['player', 'bot'] as const) {
      progress(`${side === 'player' ? 'Your fighter' : 'Sparring bot'}: deploying native account & calibrating gas…`)
      const fighter = accounts[side]
      const sender = fighter.account.address
      let sequence = await getTransactionCount(publicClient, { address: sender, nonceKey: 0n })
      const actor = key.k1(fighter.signer.address)
      const base = { sender, senderActorId: actor.actorId, senderAuthAuthenticator: canonicalAuthenticators.k1, nonceKey: 0n }
      if (await readCode(sender) === '0x') {
        // A self-transfer deploys the account without moving any USDV between fighters.
        const calls = transferCalls(token, sender, 1n)
        const gas = await estimateGas(publicClient, { ...base, nonceSequence: Number(sequence), accountChanges: [fighter.account.createChange], calls })
        const raw = await fighter.account.signTransaction({ chainId: CHAIN_ID, accountChanges: [fighter.account.createChange], calls: encodeWalletCalls({ account: sender, calls }), nonceKey: 0n, nonceSequence: sequence, maxFeePerGas, maxPriorityFeePerGas: PRIORITY_FEE, gas: (gas * 13n + 9n) / 10n })
        const hash = keccak256(raw)
        const deadline = Date.now() + 60_000
        let confirmed = false
        let lastBroadcast = 0
        while (Date.now() < deadline) {
          const receipt = await readReceipt(hash)
          if (receipt) {
            if (receipt.status === '0x0' || receipt.status === 'reverted' || !allPhasesSucceeded(receipt.eip8130 ?? receipt)) throw new Error(`Account deployment reverted: ${hash}`)
            confirmed = true; break
          }
          if (Date.now() - lastBroadcast > 1_500) {
            lastBroadcast = Date.now()
            // Re-send only identical signed bytes; a lost RPC response never creates a second deployment.
            await sendRaw(raw).catch(() => undefined)
          }
          await sleep(350)
        }
        if (!confirmed) throw new Error(`Deployment unconfirmed. Retry checks this same account before continuing. ${hash}`)
        sequence++
      }
      if (await readCode(sender) === '0x') throw new Error('Account code not yet readable. Retry setup shortly.')
      const calls = transferCalls(token, accounts[side === 'player' ? 'bot' : 'player'].account.address, 50_000n)
      const estimate = await estimateGas(publicClient, { ...base, nonceSequence: Number(sequence), accountChanges: [], calls })
      fighter.gas = ((estimate + nonceFreeCost - nonceKeyExistingCost) * 13n + 9n) / 10n
    }
    progress('Reading funded balances. Entering the arena…')
    const [player, bot] = await Promise.all([readTokenBalance(token, accounts.player.account.address), readTokenBalance(token, accounts.bot.account.address)])
    return { accounts, token, genesis, head: health.head, balances: { player, bot }, maxFeePerGas }
  }
}
