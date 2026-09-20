import { EXECUTION_WS } from '../../200ms-demo/src/chain/config'
import { TRANSFER_TOPIC, type RawLog } from './ledger'

/** One WSS connection, both transfer directions. Reconnects are reconciled over HTTP. */
export function connectArenaSocket(token: string, accounts: string[], callbacks: {
  log: (log: RawLog) => void; head: (number: number) => void; state: (state: string) => void
}) {
  let socket: WebSocket | undefined
  let stopped = false
  let reconnect: number | undefined
  let attempt = 0
  let id = 10
  const pending = new Map<number, { resolve: (hash: string) => void; reject: (error: Error) => void; timer: number }>()
  const connect = () => {
    if (stopped) return
    callbacks.state(attempt ? 'Reconnecting' : 'Connecting')
    const ws = new WebSocket(EXECUTION_WS)
    socket = ws
    let logs = '', heads = ''
    const deadline = window.setTimeout(() => ws.close(), 6_000)
    ws.onopen = () => {
      const topics = accounts.map(a => `0x${a.slice(2).padStart(64, '0')}`)
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['logs', { address: token, topics: [TRANSFER_TOPIC, topics, topics] }] }))
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'eth_subscribe', params: ['newHeads'] }))
    }
    ws.onmessage = event => {
      try {
        const m = JSON.parse(String(event.data))
        if (m.id === 1 || m.id === 2) {
          if (m.error || typeof m.result !== 'string') { ws.close(); return }
          if (m.id === 1) logs = m.result; else heads = m.result
          if (logs && heads) { clearTimeout(deadline); attempt = 0; callbacks.state('Live WSS') }
        } else if (pending.has(m.id)) {
          const p = pending.get(m.id)!
          clearTimeout(p.timer); pending.delete(m.id)
          if (m.error) p.reject(new Error(m.error.message ?? 'Broadcast rejected'))
          else if (typeof m.result === 'string') p.resolve(m.result)
          else p.reject(new Error('Invalid RPC response'))
        } else if (m.method === 'eth_subscription') {
          if (m.params?.subscription === logs) callbacks.log(m.params.result)
          if (m.params?.subscription === heads && m.params.result?.number) callbacks.head(Number(BigInt(m.params.result.number)))
        }
      } catch { /* Invalid notifications never confirm transfers. */ }
    }
    ws.onerror = () => ws.close()
    ws.onclose = () => {
      clearTimeout(deadline)
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('WebSocket disconnected')) }
      pending.clear()
      if (!stopped) {
        callbacks.state('Reconnecting · HTTP fallback')
        reconnect = window.setTimeout(connect, Math.min(5_000, 400 * 2 ** Math.min(attempt++, 4)))
      }
    }
  }
  connect()
  return {
    send(raw: string): Promise<string> {
      if (socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('WebSocket offline'))
      const current = ++id
      return new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => { pending.delete(current); reject(new Error('Broadcast response timed out')) }, 2_000)
        pending.set(current, { resolve, reject, timer })
        socket!.send(JSON.stringify({ jsonrpc: '2.0', id: current, method: 'eth_sendRawTransaction', params: [raw] }))
      })
    },
    close() { stopped = true; clearTimeout(reconnect); socket?.close() },
  }
}
