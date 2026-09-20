export const MODEL = 'typesafe-ai/jev' as const
export const ACTIONS = ['punch', 'kick', 'block', 'approach', 'retreat', 'wait'] as const
export type Action = typeof ACTIONS[number]
export const isAction = (value: unknown): value is Action => typeof value === 'string' && (ACTIONS as readonly string[]).includes(value)
const MOVES = ['idle', 'walk', 'punch', 'kick', 'block', 'hit', 'ko']
type FighterState = { x: number; hp: number; move: string; cooldownMs: number; sinceHitMs: number; combo: number }
export type Snapshot = { version: 1; remainingMs: number; player: FighterState; jev: FighterState }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).length === allowed.length && Object.keys(v).every(k => allowed.includes(k))
const number = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v >= min && v <= max
function fighter(v: unknown): v is FighterState {
  return object(v) && keys(v, ['x', 'hp', 'move', 'cooldownMs', 'sinceHitMs', 'combo']) &&
    number(v.x, 45, 595) && number(v.hp, 0, 180) && typeof v.move === 'string' && MOVES.includes(v.move) &&
    number(v.cooldownMs, 0, 800) && number(v.sinceHitMs, 0, 10_000) && number(v.combo, 0, 240)
}
/** No arbitrary strings, prompts, model overrides, addresses or extra properties. */
export function isSnapshot(v: unknown): v is Snapshot {
  return object(v) && keys(v, ['version', 'remainingMs', 'player', 'jev']) && v.version === 1 &&
    number(v.remainingMs, 0, 60_000) && fighter(v.player) && fighter(v.jev) && v.player.x < v.jev.x
}
