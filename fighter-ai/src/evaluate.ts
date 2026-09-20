import { experimental_evaluate as evaluate } from 'ai'
import { gateway } from '@ai-sdk/gateway'
import { MODEL, type Snapshot } from './contract.ts'

// Experimental SDK API: package.json pins both SDK and gateway versions.
export const questions = {
  action: {
    type: 'choice',
    instructions: 'You are Jev, the orange fighter on the right, playing against a human on the left. Choose your next short action to win a 60-second fighting round by knockout or higher remaining health. State positions and ranges are pixels; times are milliseconds of active combat. sinceHitMs is time since that fighter last landed a hit, capped at 10000. Approach moves toward the human, retreat away; fighters cannot cross. An action lasts at most 650ms, attacks obey cooldown and pose locks. Jev moves at 100px/s, human at 180px/s. Punch does 2 damage within 84px; kick does 3 within 108px. Block prevents damage and hit transfers but cannot move or attack. Attack only when in range and ready, close distance if far, defend or retreat tactically from attacks. Only choose one listed action. No narration.',
    criteria: {
      punch: 'Punch when ready and within 84 pixels.',
      kick: 'Kick when ready and within 108 pixels, particularly outside punch range.',
      block: 'Defend against a nearby attack; blocks cause no damage or transfer.',
      approach: 'Move toward the human to enter attack range.',
      retreat: 'Move away from the human for space or to avoid an attack.',
      wait: 'Stay neutral briefly, for example while recovering or on cooldown.',
    },
  },
} as const

export async function decide(snapshot: Snapshot, abortSignal: AbortSignal): Promise<unknown> {
  const result = await evaluate({
    model: gateway.evaluationModel(MODEL),
    state: { ...snapshot, ranges: { punch: 84, kick: 108 } },
    questions,
    maxRetries: 0,
    abortSignal,
  })
  return result.answers.action.choice
}
