export const PREDICTION_MODEL = 'typesafe-ai/jev'
export type Pick = 'up' | 'down'
export type PricePoint = { price: number; time: number }
export type PredictionSnapshot = { version: 1; ticks: PricePoint[] }
export const isPick = (value: unknown): value is Pick => value === 'up' || value === 'down'
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
export function isPredictionSnapshot(value: unknown, now = Date.now()): value is PredictionSnapshot {
  if (!object(value) || Object.keys(value).sort().join() !== 'ticks,version' || value.version !== 1 || !Array.isArray(value.ticks) || value.ticks.length < 2 || value.ticks.length > 32) return false
  let previous = 0
  for (const tick of value.ticks) {
    if (!object(tick) || Object.keys(tick).sort().join() !== 'price,time' || typeof tick.price !== 'number' || !Number.isFinite(tick.price) || tick.price <= 0 || tick.price > 10_000_000 || typeof tick.time !== 'number' || !Number.isSafeInteger(tick.time) || tick.time <= previous || now - tick.time > 30_000 || tick.time > now + 250) return false
    previous = tick.time
  }
  return now - previous <= 1_000
}
