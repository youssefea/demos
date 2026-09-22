import { OBSERVATION_FUTURE_SKEW, OBSERVATION_MAX_AGE, type PricePoint } from '../../fighter-ai/src/prediction-contract.ts'
/** time is the millisecond observation time; sourceTime preserves exchange microseconds. */
export type Tick = PricePoint & { sourceTime: number; receivedAt: number; tradeId: number; kind: 'trade' | 'heartbeat' }
export const MAX_AGE = OBSERVATION_MAX_AGE
export const FUTURE_SKEW = OBSERVATION_FUTURE_SKEW
export const PRICE_WINDOW = 1_000
export const PROOF_WAIT = 4_000

function sourceTime(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const parts = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,6}))?Z$/.exec(value)
  if (!parts) return null
  const micros = Date.parse(`${parts[1]}Z`) * 1_000 + Number((parts[2] ?? '').padEnd(6, '0'))
  return Number.isSafeInteger(micros) && micros > 0 ? micros : null
}
const validId = (id: unknown): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id >= 0
export function parseTick(value: unknown, now: number): Tick | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if ((v.type !== 'match' && v.type !== 'last_match') || v.product_id !== 'BTC-USD' || typeof v.price !== 'string' || !/^\d+(\.\d{1,8})?$/.test(v.price) || !validId(v.trade_id)) return null
  const price = Number(v.price), source = sourceTime(v.time)
  // An old last trade is normal in a quiet market. Only a verified heartbeat establishes liveness.
  if (source === null || price <= 0 || price > 10_000_000 || source / 1_000 - now > FUTURE_SKEW) return null
  return { price, time: Math.floor(source / 1_000), sourceTime: source, tradeId: v.trade_id, receivedAt: now, kind: 'trade' }
}
export class PriceBook {
  // Bounded presentation/model history, NOT the source of the active round's cutoff candidate.
  ticks: Tick[] = []
  connected = false
  generation = 0
  error = ''
  private trade?: Tick
  private heartbeat?: Tick
  get latest() { return this.ticks.at(-1) }
  reset() {
    this.generation++; this.connected = false; this.error = ''; this.ticks = []; this.trade = undefined; this.heartbeat = undefined
  }
  private fail(reason: string): null { this.error ||= reason; return null }
  fresh(now: number) {
    const h = this.heartbeat
    return this.connected && !this.error && !!h && now - h.time <= MAX_AGE && h.sourceTime / 1_000 - now <= FUTURE_SKEW && now - h.receivedAt <= MAX_AGE && now >= h.receivedAt
  }
  private record(tick: Tick) {
    // Coalesce same-ms observations for the price-only API's strictly increasing timestamps.
    // Every ordered trade is still returned to the round, including sub-ms/same-ms changes.
    this.ticks = [...this.ticks.filter(t => tick.time - t.time < 30_000 && t.time < tick.time).slice(-31), tick]
    return tick
  }
  add(value: unknown, now: number): Tick | null {
    if (this.error || !value || typeof value !== 'object') return null
    const v = value as Record<string, unknown>
    if (v.product_id !== 'BTC-USD') return null
    if (v.type === 'heartbeat') {
      const source = sourceTime(v.time)
      if (source === null || !validId(v.last_trade_id) || source / 1_000 - now > FUTURE_SKEW) return this.fail('Invalid exchange heartbeat')
      if (this.heartbeat && source <= this.heartbeat.sourceTime) return null // Duplicate/old heartbeat.
      if (!this.trade) return null // Await the subscription's last_match seed.
      if (v.last_trade_id !== this.trade.tradeId) return this.fail('Heartbeat trade coverage mismatch')
      if (source < this.trade.sourceTime) return this.fail('Heartbeat precedes its last trade')
      if (now - source / 1_000 > MAX_AGE) return null // Old proof cannot restore liveness.
      const tick: Tick = { ...this.trade, kind: 'heartbeat', sourceTime: source, time: Math.floor(source / 1_000), receivedAt: now }
      this.heartbeat = tick
      return this.record(tick)
    }
    if (v.type !== 'match' && v.type !== 'last_match') return null
    const tick = parseTick(v, now)
    if (!tick) return this.fail('Invalid exchange trade')
    if (this.trade) {
      if (tick.tradeId <= this.trade.tradeId) return null // Duplicate/out-of-order old frame.
      if (v.type === 'last_match' || tick.tradeId !== this.trade.tradeId + 1) return this.fail('Missing exchange trade')
      if (tick.sourceTime < this.trade.sourceTime || (this.heartbeat && tick.sourceTime < this.heartbeat.sourceTime)) return this.fail('Trade timestamp went backwards')
    } else if (v.type !== 'last_match') return null
    this.trade = tick
    return this.record(tick)
  }
  snapshot(now: number) {
    // Heartbeat samples are the real last-trade price observed at exchange heartbeat time,
    // not synthetic trades. Trade inactivity does not make these observations stale.
    return { version: 1 as const, ticks: this.ticks.filter(t => now - t.time < 30_000).map(({ price, time }) => ({ price, time })) }
  }
}
export function connectPrices(book: PriceBook, onTick: (tick: Tick) => void, onState: () => void) {
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined, ws: WebSocket | undefined
  let openedAt = Date.now()
  const connect = () => {
    if (stopped) return
    book.reset(); openedAt = Date.now()
    const socket = new WebSocket('wss://ws-feed.exchange.coinbase.com'); ws = socket
    socket.onopen = () => {
      if (stopped || socket !== ws) return
      book.connected = true; onState()
      socket.send(JSON.stringify({ type: 'subscribe', product_ids: ['BTC-USD'], channels: ['matches', 'heartbeat'] }))
    }
    socket.onmessage = event => {
      if (stopped || socket !== ws) return
      try {
        const tick = book.add(JSON.parse(String(event.data)), Date.now())
        if (book.error) { book.connected = false; onState(); socket.close() }
        else if (tick) onTick(tick)
      } catch { /* Non-JSON messages cannot prove market coverage. */ }
    }
    socket.onerror = () => socket.close()
    socket.onclose = () => {
      if (socket !== ws) return
      book.connected = false; onState()
      if (!stopped) timer = setTimeout(connect, 1_000)
    }
  }
  connect()
  // Resubscribe even if a broken/quiet connection never emits a close event or seed.
  const health = setInterval(() => {
    if (ws && Date.now() - openedAt > PROOF_WAIT && !book.fresh(Date.now())) {
      book.connected = false; onState(); ws.close()
    }
  }, 1_000)
  return () => { stopped = true; clearTimeout(timer); clearInterval(health); book.connected = false; ws?.close() }
}
