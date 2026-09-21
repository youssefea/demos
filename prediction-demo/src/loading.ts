export const SETUP_STEPS = [
  { id: 'connect', title: 'Waking up Vibenet', description: 'Checking the network and test contracts.' },
  { id: 'accounts', title: 'Setting up your account', description: 'Creating wallets for you, Jev and the pot.' },
  { id: 'funding', title: 'Making you test-rich', description: 'Getting test gas and play money from the faucet.' },
  { id: 'deploy', title: 'Onchaining the squad', description: 'Deploying the wallets and confirming their transactions.' },
  { id: 'verify', title: 'Counting the pretend money', description: 'Checking balances before we let you loose.' },
] as const
export type SetupPhase = typeof SETUP_STEPS[number]['id']
export type SetupProgress = { phase: SetupPhase; detail: string; at: number; remainingSeconds?: number }
export const initialProgress = (): SetupProgress => ({ phase: 'connect', detail: SETUP_STEPS[0].description, at: Date.now() })

/** Budget from the faucet's advertised cooldown, not a claim that any transaction has completed. */
export function fundingEstimate(dripsRemaining: number, cooldownSeconds: number) {
  const cooldown = Number.isFinite(cooldownSeconds) && cooldownSeconds >= 0 ? cooldownSeconds : 15
  return Math.ceil(dripsRemaining * (cooldown + 1 + 2) + 12)
}
export function estimateLabel(progress: SetupProgress, now: number): string {
  if (progress.remainingSeconds === undefined) return 'Usually about a minute'
  const remaining = progress.remainingSeconds - Math.max(0, now - progress.at) / 1000
  if (remaining <= 0) return 'Taking a little longer than estimated'
  if (remaining <= 10) return 'About 10 seconds left'
  const rounded = Math.ceil(remaining / 5) * 5
  return `About ${Math.max(10, rounded - 10)}–${rounded + 10} seconds left`
}
