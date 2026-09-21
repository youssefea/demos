import type { IncomingMessage, ServerResponse } from 'node:http'
import { isAction, isSnapshot, MODEL, type Snapshot } from './contract.ts'

export const MAX_BODY_BYTES = 2_048
export const TIMEOUT_MS = 2_000
const ORIGINS = new Set(['https://youssefea.github.io', 'http://localhost:5174', 'http://localhost:4173'])
type Request = IncomingMessage & { body?: unknown }
type Inference<T> = (snapshot: T, signal: AbortSignal) => Promise<unknown>

/** Best effort per warm instance, not distributed abuse/cost protection. */
export class RateLimit {
  private buckets = new Map<string, { tokens: number; at: number }>()
  take(ip: string, now = Date.now()): boolean {
    // Bound memory without evicting still-active clients (which would bypass limits).
    if (this.buckets.size >= 10_000) {
      for (const [key, bucket] of this.buckets) if (now - bucket.at > 60_000) this.buckets.delete(key)
      if (!this.buckets.has(ip) && this.buckets.size >= 10_000) return false
    }
    const b = this.buckets.get(ip) ?? { tokens: 6, at: now }
    b.tokens = Math.min(6, b.tokens + Math.max(0, now - b.at) * .003)
    b.at = now
    this.buckets.set(ip, b)
    if (b.tokens < 1) return false
    b.tokens--
    return true
  }
}

class BodyError extends Error { status: number; constructor(status: number) { super('Invalid body'); this.status = status } }
async function body(req: Request): Promise<unknown> {
  const length = req.headers['content-length']
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) throw new BodyError(413)
  // Vercel may have parsed JSON already; local Node HTTP requests are streams.
  if (req.body !== undefined) {
    const raw = typeof req.body === 'string' ? req.body : Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body)
    if (Buffer.byteLength(raw) > MAX_BODY_BYTES) throw new BodyError(413)
    return JSON.parse(raw)
  }
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.from(chunk); size += bytes.length
    if (size > MAX_BODY_BYTES) { req.resume(); throw new BodyError(413) }
    chunks.push(bytes)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export function createHandler(infer: Inference<Snapshot>, limit = new RateLimit(), timeoutMs = TIMEOUT_MS) {
  return createDecisionHandler(infer, { validate: isSnapshot, validAnswer: isAction, field: 'action', model: MODEL, origins: ORIGINS, invalid: 'Invalid combat snapshot' }, limit, timeoutMs)
}

export function createDecisionHandler<T>(infer: Inference<T>, options: {
  validate: (value: unknown) => value is T; validAnswer: (value: unknown) => boolean
  field: string; model: string; origins: ReadonlySet<string>; invalid: string
}, limit = new RateLimit(), timeoutMs = TIMEOUT_MS) {
  return async (req: Request, res: ServerResponse) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Vary', 'Origin')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    const reply = (status: number, value?: object) => {
      res.statusCode = status
      res.setHeader('Content-Type', 'application/json')
      res.end(value ? JSON.stringify(value) : undefined)
    }
    const origin = req.headers.origin
    if (origin && !options.origins.has(origin)) return reply(403, { error: 'Origin not allowed' })
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin)
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
      res.setHeader('Access-Control-Max-Age', '600')
      return reply(204)
    }
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST, OPTIONS'); return reply(405, { error: 'POST required' }) }
    // Vercel overwrites this header. Locally use the socket, not a caller-supplied X-Forwarded-For.
    const forwarded = req.headers['x-vercel-forwarded-for']
    const ip = process.env.VERCEL && typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : req.socket.remoteAddress ?? 'unknown'
    if (!limit.take(ip)) { res.setHeader('Retry-After', '1'); return reply(429, { error: 'Too many decisions' }) }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) return reply(415, { error: 'JSON required' })
    let snapshot: unknown
    try { snapshot = await body(req) } catch (error) { return reply(error instanceof BodyError ? error.status : 400, { error: 'Invalid snapshot body' }) }
    if (!options.validate(snapshot)) return reply(400, { error: options.invalid })
    const controller = new AbortController()
    const disconnected = () => { if (!res.writableEnded) controller.abort() }
    res.on('close', disconnected)
    let timer: ReturnType<typeof setTimeout> | undefined
    const started = performance.now()
    try {
      // The race also bounds a misbehaving provider; abortSignal cancels normal SDK fetches.
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')) }, timeoutMs)
      })
      const action = await Promise.race([infer(snapshot, controller.signal), timeout])
      if (controller.signal.aborted || !options.validAnswer(action)) throw new Error('Invalid decision')
      return reply(200, { [options.field]: action, model: options.model, inferenceMs: Math.round(performance.now() - started) })
    } catch {
      // Do not expose provider details, credentials, prompt text or a fake fallback action.
      return reply(503, { error: 'Jev unavailable' })
    } finally {
      clearTimeout(timer)
      res.off('close', disconnected)
    }
  }
}
