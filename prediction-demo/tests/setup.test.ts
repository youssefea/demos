import test from 'node:test'
import assert from 'node:assert/strict'
import { DONOR_GAS_RESERVE, RECIPIENT_GAS_TARGET, Setup, type SetupDependencies, type Wallet } from '../src/setup-core.ts'
import { CHAIN_ID, MIN_ETH_BOOTSTRAP } from '../../200ms-demo/src/chain/config.ts'
import { STAKE } from '../src/ledger.ts'
import type { Address, Hex } from '@vibenet/aa'

const token = `0x${'aa'.repeat(20)}` as Address
const implementation = `0x${'bb'.repeat(20)}` as Address
const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address
const successReceipt = { status: '0x1', eip8130: { phaseStatuses: ['0x1'] } }

type Mode = 'success' | 'distribution-unknown' | 'distribution-reverted' | 'distribution-partial'
function harness(options: { prefunded?: boolean; playerEth?: bigint; mode?: Mode; deploymentGasCost?: bigint; failFinalReadOnce?: boolean } = {}) {
  let now = 1
  let genesis = `0x${'11'.repeat(32)}` as Hex
  let liveToken = token
  let liveImplementation = implementation
  let made = 0
  let signed = 0
  let mode: Mode = options.mode ?? 'success'
  let failFinalRead = options.failFinalReadOnce ?? false
  const codes = new Map<Address, Hex>([[token, '0x01']])
  const eth = new Map<Address, bigint>()
  const usdv = new Map<Address, bigint>()
  const receipts = new Map<Hex, any>()
  const owners = new Map<Hex, { address: Address; deployment: boolean }>()
  const faucetDrips: string[] = []
  const broadcasts: Hex[] = []
  const wallets: Wallet[] = []
  const players = new Set<Address>()
  const estimates: any[] = [], signatures: any[] = []

  const makeWallet = (): Wallet => {
    const accountAddress = address(++made)
    if (made % 3 === 1) players.add(accountAddress)
    if (options.prefunded) {
      codes.set(accountAddress, '0x01')
      eth.set(accountAddress, RECIPIENT_GAS_TARGET)
      usdv.set(accountAddress, made % 3 === 0 ? 0n : 100n * STAKE)
    } else if (made % 3 === 1 && options.playerEth !== undefined) {
      eth.set(accountAddress, options.playerEth)
    }
    const signerAddress = address(10_000 + made)
    const account = {
      address: accountAddress,
      createChange: { implementation: liveImplementation },
      async signTransaction(parameters: any) {
        signatures.push(parameters)
        const raw = `0x${(++signed).toString(16).padStart(64, '0')}` as Hex
        owners.set(raw, { address: accountAddress, deployment: parameters.accountChanges.length > 0 })
        return raw
      },
    }
    const wallet = { account, signer: { address: signerAddress }, gas: 0n } as unknown as Wallet
    wallets.push(wallet)
    return wallet
  }

  const overrides: Partial<SetupDependencies> = {
    now: () => now,
    sleep: async ms => { now += ms },
    confirmationTimeoutMs: 1_000,
    balanceTimeoutMs: 1_000,
    getChainHealth: async () => ({ healthy: true, head: 7, headAgeSecs: 0 }),
    getContracts: async () => ({}),
    getFaucetStatus: async () => ({
      address: address(900), chain_id: CHAIN_ID, drip_wei: '100000000000000000', balance_wei: '1',
      ip_cooldown_secs: 10, addr_cooldown_secs: 10, usdv_address: liveToken, usdv_drip_units: '1000000000',
    }),
    readGenesisHash: async () => genesis,
    chainId: async () => `0x${CHAIN_ID.toString(16)}`,
    resolveImplementation: async () => liveImplementation,
    resolveToken: () => liveToken,
    readCode: async accountAddress => codes.get(accountAddress) ?? '0x',
    readEthBalance: async accountAddress => eth.get(accountAddress) ?? 0n,
    readTokenBalance: async (_token, accountAddress) => {
      if (failFinalRead && codes.has(address(3))) {
        failFinalRead = false
        throw new Error('Final balance RPC temporarily unavailable')
      }
      return usdv.get(accountAddress) ?? 0n
    },
    readLatestBlock: async () => ({ number: '0x7', hash: `0x${'77'.repeat(32)}`, baseFeePerGas: '0x3b9aca00' }),
    makeWallet,
    makeFaucet: () => ({
      ensureEth: async accountAddress => {
        if ((eth.get(accountAddress) ?? 0n) >= MIN_ETH_BOOTSTRAP) return null
        faucetDrips.push(`eth:${accountAddress}`)
        eth.set(accountAddress, 100_000_000_000_000_000n)
        return `0x${'01'.repeat(32)}`
      },
      ensureUsdv: async accountAddress => {
        if ((usdv.get(accountAddress) ?? 0n) >= 20n * STAKE) return null
        faucetDrips.push(`usdv:${accountAddress}`)
        usdv.set(accountAddress, 1_000n * STAKE)
        return `0x${'02'.repeat(32)}`
      },
    }),
    transactionCount: async accountAddress => codes.get(accountAddress) ? 1n : 0n,
    estimate: async parameters => { estimates.push(parameters); return 100_000n },
    hash: raw => raw,
    readReceipt: async hash => receipts.get(hash) ?? null,
    sendRaw: async raw => {
      broadcasts.push(raw)
      const owner = owners.get(raw)!
      if (owner.deployment) {
        if (!receipts.has(raw)) eth.set(owner.address, (eth.get(owner.address) ?? 0n) - (options.deploymentGasCost ?? 0n))
        codes.set(owner.address, '0x01')
        receipts.set(raw, successReceipt)
      } else if (players.has(owner.address)) {
        if (mode === 'distribution-unknown') return raw
        if (mode === 'distribution-reverted') {
          receipts.set(raw, { status: '0x0', eip8130: { phaseStatuses: ['0x0'] } })
        } else {
          receipts.set(raw, successReceipt)
          const playerIndex = wallets.findIndex(wallet => wallet.account.address === owner.address)
          eth.set(wallets[playerIndex + 1].account.address, RECIPIENT_GAS_TARGET)
          if (mode !== 'distribution-partial') eth.set(wallets[playerIndex + 2].account.address, RECIPIENT_GAS_TARGET)
        }
      }
      return raw
    },
  }
  const setup = new Setup(overrides)
  return {
    setup, eth, usdv, codes, receipts, owners, faucetDrips, broadcasts, wallets,
    estimates, signatures,
    signed: () => signed,
    setMode: (next: Mode) => { mode = next },
    setGenesis: (next: Hex) => { genesis = next },
    setToken: (next: Address) => { liveToken = next; codes.set(next, '0x01') },
    setImplementation: (next: Address) => { liveImplementation = next },
  }
}

const run = (setup: Setup) => setup.run(() => undefined)

test('fresh setup uses exactly one ETH drip, two USDV drips, and one native distribution', async () => {
  const h = harness()
  const runtime = await run(h.setup)
  assert.deepEqual(h.faucetDrips.map(entry => entry.split(':')[0]), ['eth', 'usdv', 'usdv'])
  assert.equal(h.eth.get(runtime.accounts.jev.account.address), RECIPIENT_GAS_TARGET)
  assert.equal(h.eth.get(runtime.accounts.pot.account.address), RECIPIENT_GAS_TARGET)
  assert.ok((h.eth.get(runtime.accounts.player.account.address) ?? 0n) >= DONOR_GAS_RESERVE)
  assert.equal(h.signed(), 4, 'three deployments plus one distribution are signed')
})

test('prefunded deployed wallets skip all faucet drips and gas redistribution', async () => {
  const h = harness({ prefunded: true })
  await run(h.setup)
  assert.deepEqual(h.faucetDrips, [])
  assert.equal(h.signed(), 0)
  assert.deepEqual(h.broadcasts, [])
})

test('an unknown distribution retries identical signed bytes and never creates a replacement', async () => {
  const h = harness({ mode: 'distribution-unknown' })
  await assert.rejects(run(h.setup), /distribution unconfirmed/i)
  const distributionRaw = [...h.owners].find(([, value]) => !value.deployment)?.[0]
  assert.ok(distributionRaw)
  const signedAfterTimeout = h.signed()
  h.setMode('success')
  await run(h.setup)
  assert.equal(h.signed(), signedAfterTimeout + 2, 'only the two not-yet-created recipient deployments are new')
  assert.ok(h.broadcasts.filter(raw => raw === distributionRaw).length > 1)
  assert.equal([...h.owners].filter(([, value]) => !value.deployment).length, 1)
})

test('reverted and partial distribution outcomes block readiness without a duplicate top-up', async t => {
  await t.test('revert', async () => {
    const h = harness({ mode: 'distribution-reverted' })
    await assert.rejects(run(h.setup), /Gas distribution failed/)
    assert.equal([...h.owners].filter(([, value]) => !value.deployment).length, 1)
  })
  await t.test('partial balances', async () => {
    const h = harness({ mode: 'distribution-partial' })
    await assert.rejects(run(h.setup), /recipient balances did not arrive/)
    const signed = h.signed()
    await assert.rejects(run(h.setup), /recipient balances did not arrive/)
    assert.equal(h.signed(), signed, 'confirmed partial state is checked, not topped up again')
  })
})

test('setup fails clearly when one drip cannot cover transfers, worst-case gas, and donor reserve', async () => {
  const h = harness({ playerEth: 50_000_000_000_000_000n })
  await assert.rejects(run(h.setup), /One gas faucet drip is insufficient/)
  assert.equal([...h.owners].filter(([, value]) => !value.deployment).length, 0)
})

test('genesis, token, and implementation changes rotate wallets and clear signed caches', async () => {
  const h = harness()
  const first = await run(h.setup)
  h.setGenesis(`0x${'22'.repeat(32)}` as Hex)
  const afterGenesis = await run(h.setup)
  h.setToken(address(800))
  const afterToken = await run(h.setup)
  h.setImplementation(address(801))
  const afterImplementation = await run(h.setup)
  assert.notEqual(first.accounts.player.account.address, afterGenesis.accounts.player.account.address)
  assert.notEqual(afterGenesis.accounts.player.account.address, afterToken.accounts.player.account.address)
  assert.notEqual(afterToken.accounts.player.account.address, afterImplementation.accounts.player.account.address)
  assert.equal(h.wallets.length, 12)
  assert.equal([...h.owners].filter(([, value]) => !value.deployment).length, 4)
})

test('concurrent callers share one orchestration and do not duplicate faucet work', async () => {
  const h = harness()
  const first = run(h.setup)
  const second = run(h.setup)
  assert.equal(first, second)
  const runtime = await first
  assert.equal(runtime.genesis, `0x${'11'.repeat(32)}`)
  assert.deepEqual(h.faucetDrips.map(entry => entry.split(':')[0]), ['eth', 'usdv', 'usdv'])
})

test('retry after final verification failure respects gas already spent by recipient deployments', async () => {
  const gasCost = 200_000_000_000_000n
  const h = harness({ deploymentGasCost: gasCost, failFinalReadOnce: true })
  await assert.rejects(run(h.setup), /Final balance RPC temporarily unavailable/)
  const signed = h.signed(), broadcasts = h.broadcasts.length
  const runtime = await run(h.setup)
  assert.equal(h.eth.get(runtime.accounts.jev.account.address), RECIPIENT_GAS_TARGET - gasCost)
  assert.equal(h.eth.get(runtime.accounts.pot.account.address), RECIPIENT_GAS_TARGET - gasCost)
  assert.equal(h.signed(), signed, 'no replacement distribution or deployment')
  assert.equal(h.broadcasts.length, broadcasts, 'confirmed setup transactions are not sent again')
  assert.equal(h.faucetDrips.length, 3)
})

test('native gas estimate uses the exact encoded wallet batch that is signed', async () => {
  const h = harness()
  const runtime = await run(h.setup)
  const distribution = h.signatures.find(parameters => parameters.accountChanges.length === 0)
  assert.ok(distribution)
  assert.equal(distribution.calls.length, 1)
  assert.equal(distribution.calls[0].length, 1, 'native transfers share one executeBatch call')
  assert.equal(distribution.calls[0][0].to, runtime.accounts.player.account.address)
  assert.ok(distribution.calls[0][0].data.startsWith('0x34fcd5be'), 'executeBatch selector')
  const estimate = h.estimates.find(parameters => parameters.calls[0]?.[0]?.data?.startsWith('0x34fcd5be'))
  assert.ok(estimate, 'raw native calls would underestimate the actual wallet wrapper')
  assert.deepEqual(estimate.calls, distribution.calls)
  assert.equal(distribution.gas, 130_000n)
})
