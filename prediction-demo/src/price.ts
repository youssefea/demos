import type { PricePoint } from '../../fighter-ai/src/prediction-contract.ts'
export type Tick = PricePoint & { receivedAt: number; tradeId: number }
export const MAX_AGE = 750
export const FUTURE_SKEW = 250
export const END_TOLERANCE = 250
export const PRICE_WINDOW = 1_000

export function parseTick(value: unknown, now: number): Tick | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (v.type !== 'ticker' || v.product_id !== 'BTC-USD' || typeof v.price !== 'string' || !/^\d+(\.\d{1,8})?$/.test(v.price) || typeof v.time !== 'string' || typeof v.trade_id !== 'number' || !Number.isSafeInteger(v.trade_id) || v.trade_id < 0) return null
  const price = Number(v.price), time = Date.parse(v.time)
  if (!Number.isFinite(time) || price <= 0 || price > 10_000_000 || now - time > MAX_AGE || time - now > FUTURE_SKEW) return null
  return { price, time, tradeId: v.trade_id, receivedAt: now }
}
export class PriceBook {
  ticks: Tick[] = []
  connected = false
  get latest() { return this.ticks.at(-1) }
  fresh(now: number) {
    const t = this.latest
    return this.connected && !!t && now - t.time <= MAX_AGE && t.time - now <= FUTURE_SKEW && now - t.receivedAt <= MAX_AGE && now >= t.receivedAt
  }
  add(value: unknown, now: number): Tick | null {
    const tick = parseTick(value, now)
    if (!tick || (this.latest && (tick.time <= this.latest.time || tick.tradeId <= this.latest.tradeId))) return null
    this.ticks = [...this.ticks.filter(t => now - t.time < 30_000).slice(-31), tick]
    return tick
  }
  snapshot(now: number) { return { version: 1 as const, ticks: this.ticks.filter(t => now - t.time < 30_000).map(({ price, time }) => ({ price, time })) } }
}
/** Trade timestamps define the horizon; never compare a cached/polled price as though it were exact. */
export function endTick(baseline: Tick, previous: Tick, tick: Tick): 'wait' | 'end' | 'invalid' {
  if (tick.time <= previous.time || tick.time - previous.time > MAX_AGE || tick.receivedAt < previous.receivedAt || tick.receivedAt - previous.receivedAt > MAX_AGE) return 'invalid'
  const offset = tick.time - baseline.time - PRICE_WINDOW
  return offset < 0 ? 'wait' : offset <= END_TOLERANCE ? 'end' : 'invalid'
}
export function connectPrices(book: PriceBook, onTick: (tick: Tick) => void, onState: () => void) {
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined, ws: WebSocket | undefined
  const connect = () => {
    if (stopped) return
    const socket = new WebSocket('wss://ws-feed.exchange.coinbase.com'); ws = socket
    socket.onopen = () => {
      book.connected = true; onState()
      socket.send(JSON.stringify({ type: 'subscribe', product_ids: ['BTC-USD'], channels: ['ticker'] }))
    }
    socket.onmessage = event => {
      try { const tick = book.add(JSON.parse(String(event.data)), Date.now()); if (tick) onTick(tick) } catch { /* Non-price messages are never prices. */ }
    }
    socket.onerror = () => socket.close()
    socket.onclose = () => { book.connected = false; onState(); if (!stopped) timer = setTimeout(connect, 1_000) }
  }
  connect()
  return () => { stopped = true; clearTimeout(timer); ws?.close(); book.connected = false }
}
