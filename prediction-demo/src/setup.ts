import {
  estimateGas, generatePrivateKey, getTransactionCount, keccak256, newSmartAccount, privateKeyToAccount, type Address,
} from '@vibenet/aa'
import { resolveHighRateImplementation, resolveUsdv } from '../../200ms-demo/src/chain/account'
import { FaucetQueue } from '../../200ms-demo/src/chain/faucet'
import {
  getChainHealth, getContracts, getFaucetStatus, publicClient, readCode, readEthBalance, readGenesisHash,
  readLatestBlock, readReceipt, readTokenBalance, rpc, sendRaw,
} from '../../200ms-demo/src/chain/rpc'
import {
  Setup as SetupCore, type SetupDependencies, type Wallet,
} from './setup-core.ts'

export * from './setup-core.ts'

const makeWallet = (implementation: Address): Wallet => {
  const signer = privateKeyToAccount(generatePrivateKey())
  return { signer, account: newSmartAccount({ signer, implementation, salt: generatePrivateKey() }), gas: 0n }
}

const liveDependencies: Partial<SetupDependencies> = {
  getChainHealth,
  getContracts,
  getFaucetStatus,
  readGenesisHash,
  chainId: () => rpc<string>('eth_chainId'),
  resolveImplementation: resolveHighRateImplementation,
  resolveToken: resolveUsdv,
  readCode,
  readEthBalance: address => readEthBalance(address),
  readTokenBalance: (token, address) => readTokenBalance(token, address),
  readLatestBlock,
  makeWallet,
  makeFaucet: (status, token) => new FaucetQueue(status, token),
  transactionCount: address => getTransactionCount(publicClient, { address, nonceKey: 0n }),
  estimate: parameters => estimateGas(publicClient, parameters),
  readReceipt,
  sendRaw,
  hash: keccak256,
}

/** Browser setup with injectable boundaries retained for deterministic orchestration tests. */
export class Setup extends SetupCore {
  constructor(overrides: Partial<SetupDependencies> = {}) {
    super({ ...liveDependencies, ...overrides })
  }
}
