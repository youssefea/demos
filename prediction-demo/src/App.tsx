import { useEffect, useRef, useState } from 'react'
import { EXPLORER_URL } from '../../200ms-demo/src/chain/config'
import { formatUnits, type Account, type Transfer } from './ledger.ts'
import { connectPrices, PriceBook, type Tick } from './price.ts'
import { PredictionNetwork } from './network.ts'
import { Setup, type Runtime } from './setup.ts'
import { Round, ROUND_LIMIT } from './round.ts'
import { infer } from './jev.ts'
import type { Pick } from '../../fighter-ai/src/prediction-contract.ts'
import LoadingScreen from './LoadingScreen.tsx'
import { initialProgress, type SetupProgress } from './loading.ts'
import { refundSummary } from './refund-summary.ts'

const usd = (n?: number) => n === undefined ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
const name = (side: Account) => side === 'player' ? 'You' : side === 'jev' ? 'Jev' : 'Pot'
const pickName = (pick?: Pick) => pick === 'up' ? '↑ Up' : pick === 'down' ? '↓ Down' : '—'

function Chart({ ticks, baseline }: { ticks: Tick[]; baseline?: Tick }) {
  if (!ticks.length) return <div className="chart-empty">Connecting to Bitcoin…</div>
  const prices = ticks.map(t => t.price), min = Math.min(...prices), max = Math.max(...prices)
  const spread = Math.max(max - min, .04), first = ticks[0].time, range = Math.max(1, ticks.at(-1)!.time - first)
  const y = (price: number) => 145 - (price - min + (spread - (max - min)) / 2) / spread * 110
  const points = ticks.map(t => `${8 + (t.time - first) / range * 584},${y(t.price)}`).join(' ')
  return <svg viewBox="0 0 600 180" role="img" aria-label="Live Bitcoin price chart">
    {[40, 90, 140].map(n => <line key={n} x1="0" y1={n} x2="600" y2={n} className="gridline" />)}
    {baseline && baseline.price >= min && baseline.price <= max && <line x1="0" x2="600" y1={y(baseline.price)} y2={y(baseline.price)} className="baseline-line" />}
    <polyline points={points} className="price-line" /><circle cx={ticks.length === 1 ? 8 : 592} cy={y(ticks.at(-1)!.price)} r="4" fill="currentColor" />
  </svg>
}
function Tx({ tx }: { tx: Transfer }) {
  return <div className="tx" data-status={tx.status}>
    <span>{name(tx.from)} → {name(tx.to)}</span>
    <span>{formatUnits(tx.amount)}</span>
    {tx.hash ? <a href={`${EXPLORER_URL}/tx/${tx.hash}`} target="_blank" rel="noreferrer">{tx.status === 'confirmed' ? `${tx.latency} ms ↗` : `${tx.status} ↗`}</a> : <span>{tx.status}</span>}
  </div>
}
function status(round: Round | null, live: boolean, blocked?: string | null) {
  if (!round) return 'Funding your test wallets…'
  if (round.phase === 'blocked') return 'Settlement needs attention. Keep this tab open.'
  if (round.phase === 'thinking') return 'Jev is picking…'
  if (round.phase === 'funding') return 'Locking $1 each…'
  if (round.phase === 'baseline') return 'Getting the starting price…'
  if (round.phase === 'watching') return Date.now() >= round.deadline ? 'Checking result…' : 'Watching the next second…'
  if (round.phase === 'settling') return round.result === 'refund' ? 'Returning both stakes…' : 'Sending the winnings…'
  if (round.number >= ROUND_LIMIT) return 'Session complete.'
  if (round.phase === 'done') {
    if (!round.stakes.length) return 'No bet placed. Try again.'
    if (round.result === 'refund') return refundSummary(round.reason, round.player)
    return round.result === 'player' ? 'You won $1. Go again.' : 'Jev won $1. Go again.'
  }
  if (blocked) return 'Waiting for Vibenet…'
  if (!live) return 'Waiting for a fresh price…'
  return 'Where does Bitcoin go next?'
}

export default function App() {
  const [, render] = useState(0)
  const refresh = () => render(n => n + 1)
  const prices = useRef(new PriceBook()).current, setup = useRef(new Setup()).current
  const setupTask = useRef<Promise<Runtime> | null>(null)
  const network = useRef<PredictionNetwork | null>(null), round = useRef<Round | null>(null)
  const [attempt, setAttempt] = useState(0), [progress, setProgress] = useState(initialProgress)
  const progressListener = useRef<(label: string, stage?: SetupProgress) => void>(() => {})
  const [error, setError] = useState(''), [selected, setSelected] = useState<Pick>()
  useEffect(() => {
    let disposed = false
    const update = () => { if (!disposed) refresh() }
    let disconnect: (() => void) | undefined
    let timer: ReturnType<typeof setInterval> | undefined
    const hide = () => { if (document.hidden) round.current?.abort('Tab hidden. Returning confirmed stakes.'); update() }
    const leaving = (event: BeforeUnloadEvent) => { if (round.current?.unsettled) { event.preventDefault(); event.returnValue = '' } }
    document.addEventListener('visibilitychange', hide)
    window.addEventListener('beforeunload', leaving)
    setError('')
    setProgress(initialProgress())
    progressListener.current = (label, stage) => {
      if (!disposed) setProgress(previous => stage ?? { ...previous, detail: label })
    }
    // Reuse the same setup promise/accounts across React effect replay; never double-fund on mount.
    setupTask.current ??= setup.run((label, stage) => progressListener.current(label, stage))
    void setupTask.current.then(runtime => {
      if (disposed) return
      const net = new PredictionNetwork(runtime, update)
      network.current = net
      round.current = new Round(net, prices, infer)
      // No market subscription or game loop until wallet funding/deployment has succeeded.
      disconnect = connectPrices(prices, tick => { round.current?.onTick(tick); update() }, () => { round.current?.advance(); update() })
      timer = setInterval(() => { round.current?.advance(); update() }, 50)
      update()
    }).catch(e => {
      if (disposed) return
      setupTask.current = null
      setError(e instanceof Error ? e.message : 'Unable to fund test wallets.')
    })
    return () => {
      disposed = true
      progressListener.current = () => {}
      disconnect?.(); clearInterval(timer)
      document.removeEventListener('visibilitychange', hide)
      window.removeEventListener('beforeunload', leaving)
      round.current?.abort('Page closed'); network.current?.close()
      round.current = null; network.current = null
    }
  }, [prices, setup, attempt])

  const r = round.current, n = network.current, live = prices.fresh(Date.now())
  if (!n || !r) return <LoadingScreen progress={progress} error={error} retry={() => setAttempt(a => a + 1)} />
  const watching = r?.phase === 'watching'
  const remaining = watching ? Math.max(0, r.deadline - Date.now()) / 1000 : 1
  const transfers = [...(n?.ledger.transfers ?? [])].reverse()
  const unresolved = !!n?.ledger.pending.length
  const canPick = !!r?.canStart
  const place = (pick: Pick) => {
    if (!r?.canStart) return
    setSelected(pick)
    void r.start(pick).finally(refresh)
    refresh()
  }
  return <div className="shell">
    <header><span className="brand">ONE SECOND</span><span>Vibenet · Test money</span></header>
    <main>
      <div className="matchup"><h1>You <span>vs</span> Jev</h1><span>$1 a pick</span></div>
      <div className="balances" aria-label="Confirmed test USDV balances">
        {(['player', 'jev'] as const).map(side => <div className="balance-row" key={side}><span>{name(side)}</span><strong>{n ? formatUnits(n.ledger.balances[side]) : '—'}</strong></div>)}
      </div>
      <section className="market" aria-label="Bitcoin prediction game">
        <div className="market-heading"><span>Bitcoin <small>BTC / USD</small></span><span className={live ? 'live' : ''}>{live ? '● Live' : 'Connecting'}</span></div>
        <div className="price-row"><div className="quote">{usd(prices.latest?.price)}</div><span className="countdown" aria-label="Price window countdown">{remaining.toFixed(watching ? 2 : 0)}s</span></div>
        <Chart ticks={prices.ticks} baseline={r?.baseline} />
        <div className="timer-track"><div style={{ width: `${watching ? remaining * 100 : 0}%` }} /></div>
        <div className="picks">
          <button className={`pick ${r?.active && selected === 'up' ? 'selected' : ''}`} aria-label="Up" disabled={!canPick} onClick={() => place('up')}>↑ Up</button>
          <button className={`pick ${r?.active && selected === 'down' ? 'selected' : ''}`} aria-label="Down" disabled={!canPick} onClick={() => place('down')}>↓ Down</button>
        </div>
        <p className="status" role="status">{unresolved && n.ledger.pending.some(tx => tx.status === 'unknown') ? 'Checking a pending transfer. Keep this tab open.' : status(r, live, n.blocked)}</p>
        {(r.active || r.player) && <p className="round-picks">You {pickName(r.player ?? selected)} <span>·</span> Jev {r.jev ? pickName(r.jev) : '…'}{r.jev && r.inferenceMs !== undefined ? ` · ${r.inferenceMs} ms AI` : ''}</p>}
        {r && !r.active && r.number >= ROUND_LIMIT && !r.unsettled && <button className="text-button" onClick={() => window.location.reload()}>Get fresh test coins</button>}
      </section>
      {transfers.length > 0 && <section className="activity" aria-label="Recent transactions"><div className="activity-heading"><span>Onchain</span><span>{transfers.filter(tx => tx.status === 'confirmed').length} confirmed</span></div>{transfers.slice(0, 3).map(tx => <Tx key={tx.id} tx={tx} />)}</section>}
      <footer><span>Win $1. Ties refunded. No real money.</span><details>
        <summary>Details</summary>
        <p>Both accounts stake 1 test USDV. After both stakes confirm, opposite picks compete on exactly one second of Coinbase BTC prices. The last trade at or before the cutoff decides; a verified exchange heartbeat confirms the result, even if no new trade occurs. Matching picks and flat prices refund. Missing feed data also refunds. Verification and chain settlement take additional time.</p>
        <p>All three wallets are controlled by this browser. Jev predicts independently; it never receives your choice. This is not trustless escrow. Never send real funds. Keep the tab open during settlement; reloading loses disposable keys.</p>
        <p>{r.number}/{ROUND_LIMIT} rounds · Pot: <span data-testid="pot-balance">{formatUnits(n.ledger.balances.pot)}</span> USDV · {n.state} · Block {n.head}</p>
        {(['player', 'jev', 'pot'] as const).map(side => <a className="account-link" key={side} href={`${EXPLORER_URL}/address/${n.runtime.accounts[side].account.address}`} target="_blank" rel="noreferrer">{name(side)}: {n.runtime.accounts[side].account.address}</a>)}
        <p>{r.reason}</p>{n.error && <p>{n.error}</p>}<button onClick={() => n.recheck()}>Recheck transfers</button>
        {transfers.length > 0 && <div className="history">{transfers.map(tx => <Tx key={tx.id} tx={tx} />)}</div>}
      </details></footer>
    </main>
  </div>
}
