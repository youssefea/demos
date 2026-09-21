import { isPick, PREDICTION_MODEL } from '../../fighter-ai/src/prediction-contract.ts'
import type { Inference } from './round.ts'
const endpoint = import.meta.env.VITE_PREDICTION_API_URL || 'https://block-fighter-jev.vercel.app/api/predict'
export const infer: Inference = async (snapshot, signal) => {
  const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(snapshot), signal, cache: 'no-store' })
  if (!response.ok) throw new Error('Jev unavailable')
  const value = await response.json()
  if (!value || value.model !== PREDICTION_MODEL || !isPick(value.pick) || !Number.isFinite(value.inferenceMs) || value.inferenceMs < 0 || value.inferenceMs > 10_000) throw new Error('Invalid Jev prediction')
  return { pick: value.pick, inferenceMs: value.inferenceMs }
}
