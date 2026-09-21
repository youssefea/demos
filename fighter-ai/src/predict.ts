import { experimental_evaluate as evaluate } from 'ai'
import { gateway } from '@ai-sdk/gateway'
import { createDecisionHandler, RateLimit, TIMEOUT_MS } from './handler.ts'
import { isPick, isPredictionSnapshot, PREDICTION_MODEL, type PredictionSnapshot } from './prediction-contract.ts'

export const predictionQuestions = {
  direction: {
    type: 'choice',
    instructions: 'You are Jev in a test-money Bitcoin direction prediction demo. Given recent Coinbase BTC-USD last-trade price observations with exchange timestamps in milliseconds, independently predict up or down over an upcoming one-second price window. Observations include coverage-verified heartbeats carrying forward the actual last-trade price; repeated values need not mean new trades. The window starts after both test stakes confirm, not at the last supplied tick. You do not know the human choice. Choose only up or down. This is a noisy short horizon, not financial advice.',
    criteria: { up: 'The end price will be higher than the start price.', down: 'The end price will be lower than the start price.' },
  },
} as const
export async function predict(snapshot: PredictionSnapshot, abortSignal: AbortSignal): Promise<unknown> {
  const result = await evaluate({ model: gateway.evaluationModel(PREDICTION_MODEL), state: snapshot, questions: predictionQuestions, maxRetries: 0, abortSignal })
  return result.answers.direction.choice
}
export function createPredictionHandler(infer = predict, limit = new RateLimit(), timeoutMs = TIMEOUT_MS) {
  return createDecisionHandler(infer, {
    validate: isPredictionSnapshot, validAnswer: isPick, field: 'pick', model: PREDICTION_MODEL,
    origins: new Set(['https://youssefea.github.io', 'http://localhost:5175', 'http://localhost:4173']),
    invalid: 'Invalid or stale price history',
  }, limit, timeoutMs)
}
