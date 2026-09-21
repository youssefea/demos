import type { Pick } from '../../fighter-ai/src/prediction-contract.ts'

/** Preserve the settlement engine's actual reason; agreement is not inferred for aborted rounds. */
export function refundSummary(reason: string, player?: Pick): string {
  if (reason.startsWith('Same prediction.')) return `Both picked ${player === 'up' ? 'Up' : 'Down'} — refunded.`
  if (reason.startsWith('Price unchanged.')) return 'BTC stayed flat — refunded.'
  if (reason.startsWith('Price feed proof timed out')) return 'Price feed timed out — refunded.'
  if (reason.startsWith('Price feed')) return 'Price feed interrupted — refunded.'
  if (reason.startsWith('Tab hidden')) return 'Tab was hidden — refunded.'
  if (reason.startsWith('Clock changed')) return 'Device clock changed — refunded.'
  if (reason.startsWith('Network unavailable')) return 'Network unavailable — refunded.'
  if (reason.startsWith('A stake failed')) return 'A stake failed — confirmed funds returned.'
  return 'Round canceled — refunded.'
}
