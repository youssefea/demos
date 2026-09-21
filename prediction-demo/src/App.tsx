import { useEffect, useRef, useState } from 'react'
import { CHAIN_ID, EXPLORER_URL } from '../../200ms-demo/src/chain/config'
import { formatUnits, type Account } from './ledger.ts'
import { connectPrices, PriceBook, type Tick } from './price.ts'
import { PredictionNetwork } from './network.ts'
import { Setup } from './setup.ts'
import { Round, ROUND_LIMIT } from './round.ts'
import { infer } from './jev.ts'
const usd = (n?: number) => n === undefined ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })
const name = (side: Account) => side === 'player' ? 'You' : side === 'jev' ? 'Jev' : 'Round pot'
const short = (s: string) => `${s.slice(0, 6)}…${s.slice(-4)}`
const pickName = (pick?: string) => pick === 'up' ? '↗ Up' : pick === 'down' ? '↘ Down' : '—'
function Chart({ ticks, baseline }: { ticks: Tick[]; baseline?: Tick }) {
  const prices = ticks.map(t => t.price), min = Math.min(...prices), max = Math.max(...prices), spread = Math.max(max - min, .04)
  const first = ticks[0]?.time ?? 0, range = Math.max(1, (ticks.at(-1)?.time ?? 0) - first)
  const y = (price: number) => 150 - (price - min + (spread - (max - min)) / 2) / spread * 110
  const points = ticks.map(t => `${20 + (t.time - first) / range * 680},${y(t.price)}`).join(' ')
  return <svg viewBox="0 0 720 190" role="img" aria-label={ticks.length > 1 ? 'Recent live Coinbase Bitcoin trade prices' : 'Waiting for live Bitcoin prices'}>
    {[40, 95, 150].map(n => <line key={n} x1="0" y1={n} x2="720" y2={n} className="gridline" />)}
    {ticks.length > 1 && <><polyline points={points} className="price-line" /><circle cx="700" cy={y(ticks.at(-1)!.price)} r="4" fill="currentColor" /></>}
    {baseline && baseline.price >= min && baseline.price <= max && <line x1="0" x2="720" y1={y(baseline.price)} y2={y(baseline.price)} className="baseline-line" />}
    {!ticks.length && <text x="360" y="100" textAnchor="middle">Connecting to Coinbase Exchange…</text>}
  </svg>
}
export default function App() {
  const [, render] = useState(0)
  const refresh = () => render(n => n + 1)
  const prices = useRef(new PriceBook()).current
  const setup = useRef(new Setup()).current
  const network = useRef<PredictionNetwork | null>(null), round = useRef<Round | null>(null)
  const [busy, setBusy] = useState(false), [progress, setProgress] = useState(''), [error, setError] = useState('')
  useEffect(() => {
    const disconnect = connectPrices(prices, tick => { round.current?.onTick(tick); refresh() }, () => { round.current?.advance(); refresh() })
    const timer = setInterval(() => { round.current?.advance(); refresh() }, 50)
    const hide = () => { if (document.hidden) round.current?.abort('Tab hidden. Returning confirmed stakes.'); refresh() }
    const leaving = (event: BeforeUnloadEvent) => { if (round.current?.unsettled) { event.preventDefault(); event.returnValue = '' } }
    document.addEventListener('visibilitychange', hide); window.addEventListener('beforeunload', leaving)
    return () => { disconnect(); clearInterval(timer); document.removeEventListener('visibilitychange', hide); window.removeEventListener('beforeunload', leaving); round.current?.abort('Page closed'); network.current?.close() }
  }, [prices])
  async function prepare() {
    if (busy || network.current) return
    setBusy(true); setError('')
    try {
      const runtime = await setup.run(setProgress)
      const net = new PredictionNetwork(runtime, refresh)
      network.current = net; round.current = new Round(net, prices, infer)
      setProgress('Three test accounts ready. No stakes submitted yet.')
    } catch (e) { setError(e instanceof Error ? e.message : 'Setup unavailable. Please retry.') }
    finally { setBusy(false) }
  }
  const r = round.current, n = network.current, live = prices.fresh(Date.now())
  const picking = r?.phase === 'picking', watching = r?.phase === 'watching'
  const remaining = picking || watching ? Math.max(0, r!.deadline - Date.now()) / 1000 : 1
  const title = r?.phase === 'thinking' ? 'Jev is thinking.' : picking ? 'Your next second starts here.' : watching ? 'A lot can change in a second.' : r?.phase === 'done' ? r.stakes.length ? r.result === 'refund' ? 'This one’s a draw.' : r.result === 'player' ? 'You called it.' : 'Jev called it.' : 'No bet this round.' : r?.unsettled ? 'Let the chain catch up.' : 'Can you beat the next second?'
  return <div className="shell">
    <header><a className="brand" href="./"><span className="mark">1</span> ONE SECOND<span className="brand-sub">/ YOU VS JEV</span></a><span className="network-pill"><span className="dot" /> Base Vibenet <b>TESTNET</b></span></header>
    <main>
      <section className="intro"><p className="eyebrow">HUMAN INSTINCT. AI PREDICTION. REAL TEST TRANSACTIONS.</p><h1>{title}</h1><p>Bitcoin. Up or down. One second. <strong>1 test USDV each.</strong></p></section>
      <div className="game-grid">
        <section className="market card" aria-label="Bitcoin price and round">
          <div className="market-top"><div><span className="asset">₿</span><span><b>Bitcoin</b><small>BTC / USD · Coinbase Exchange</small></span></div><span className={`feed-state ${live ? 'is-live' : ''}`}><span className="dot" />{live ? 'Live trades' : 'Waiting for fresh price'}</span></div>
          <div className="quote">{usd(prices.latest?.price)}</div>
          <p className="quote-caption">{prices.latest ? `Exchange time ${new Date(prices.latest.time).toISOString().slice(11, 23)} UTC · ${Math.max(0, Date.now() - prices.latest.receivedAt)} ms since receipt` : 'Only real market data. No simulated prices.'}</p>
          <Chart ticks={prices.ticks} baseline={r?.baseline} />
          <div className="price-foot"><span>Recent trades · auto-scaled</span><span>Baseline {usd(r?.baseline?.price)} <i>→</i> End {usd(r?.end?.price)}</span></div>
          <div className="round-zone">
            <div className="round-heading"><span className="eyebrow">{picking ? 'LOCK YOUR PICK' : watching ? 'PRICE WINDOW' : 'THE NEXT ROUND'}</span><span className="round-count">{r?.number ?? 0} / {ROUND_LIMIT} rounds</span></div>
            <div className="countdown" aria-label={picking ? 'Betting countdown' : 'Price window countdown'}>{remaining.toFixed(2)}<span>s</span></div>
            <div className="timer-track"><div style={{ width: `${remaining * 100}%` }} /></div>
            <div className="picks"><button className={`pick ${r?.player === 'up' ? 'selected' : ''}`} disabled={!picking} onClick={() => { r?.pick('up'); refresh() }}><span>↗</span> Up <small>BTC goes higher</small></button><button className={`pick ${r?.player === 'down' ? 'selected' : ''}`} disabled={!picking} onClick={() => { r?.pick('down'); refresh() }}><span>↘</span> Down <small>BTC goes lower</small></button></div>
            <div className="choice-row"><span>Your pick <b>{pickName(r?.player)}</b></span><span>Jev’s pick <b>{r?.phase === 'thinking' ? 'Thinking…' : picking ? 'Locked · hidden' : pickName(r?.jev)}</b></span></div>
            <p className="status" role="status">{r?.reason || (n ? 'Ready when you are. Jev picks first; then you have one second.' : 'Set up disposable test accounts to play. No wallet needed.')}</p>
            {!n ? <><button className="primary" disabled={busy} onClick={() => void prepare()}>{busy ? 'Setting up test accounts…' : error ? 'Retry setup' : 'Set up test accounts'}</button>{progress && <p className="setup-progress">{progress}</p>}</> : <><button className="primary" disabled={!r?.canStart} onClick={() => { void r!.start().finally(refresh); refresh() }}>{r?.number === ROUND_LIMIT ? '20-round session complete' : r?.active ? 'Round in progress' : 'Start a $1 test round →'}</button>{!r?.active && !r?.canStart && <p className="setup-progress">{n.blocked || (!live ? 'Waiting for a fresh Bitcoin trade…' : r?.number === ROUND_LIMIT ? 'Session limit reached. No further stakes can be submitted.' : 'Waiting for prices, balances, or outstanding settlement.')}</p>}</>}
            {error && <p className="error" role="alert">{error}</p>}
            <p className="rule">Same picks or flat price? Both stakes refunded. Winner gets the 2-USDV pot: <b>+1 net.</b></p>
          </div>
        </section>
        <aside>
          <section className="card wallet-card"><div className="section-heading"><h2>The table</h2><span>TEST USDV</span></div>{(['player', 'jev', 'pot'] as const).map(side => <div className="balance-row" key={side}><span className={`avatar ${side}`}>{side === 'player' ? 'Y' : side === 'jev' ? 'J' : '↔'}</span><div><b>{name(side)}</b><small>{side === 'player' ? 'Human instinct' : side === 'jev' ? 'typesafe-ai/jev' : 'Browser-controlled test escrow'}</small></div><strong>{n ? formatUnits(n.ledger.balances[side]) : '—'}</strong></div>)}<div className="wallet-note">Confirmed balances only. Both stakes move onchain before the price window opens.</div></section>
          <section className="card flow-card"><h2>One second, not one transaction.</h2><ol><li><b>Jev predicts. You pick.</b><span>Independent choices. One second to choose.</span></li><li><b>Two stakes confirm.</b><span>Native account abstraction. 1 USDV each.</span></li><li><b>Watch the next second.</b><span>Fresh baseline → first trade at +1.00–1.25s.</span></li><li><b>The pot moves.</b><span>Payout or refunds, with verified receipts.</span></li></ol><p>Market time and chain confirmation time are measured separately. Stale prices, gaps or a hidden tab void an unfinished price round.</p></section>
          <section className="trust-note"><b>Test money. Transparent limits.</b><p>This browser holds all three disposable keys. Jev predicts; it does not hold a wallet. This is not trustless escrow or a financial product.</p><p><strong>Do not close or reload during settlement.</strong> Keys and history are lost on reload. Never send real funds.</p></section>
        </aside>
      </div>
      <section className="card transactions"><div className="section-heading"><div><h2>Money in motion</h2><p>Real native AA transfers · {n?.state ?? 'not connected'}{n ? ` · block ${n.head.toLocaleString()}` : ''}</p></div><span>{n?.ledger.transfers.filter(t => t.status === 'confirmed').length ?? 0} confirmed</span></div>
        {!n?.ledger.transfers.length ? <div className="empty-feed"><span>↔</span>Every stake, refund and payout will appear here.<small>No stakes are submitted until you lock a pick.</small></div> : <div className="tx-list">{[...n.ledger.transfers].reverse().map(tx => <article className="tx" key={tx.id}><span className="tx-round">R{tx.round.toString().padStart(2, '0')}</span><div><b>{name(tx.from)} <i>→</i> {name(tx.to)}</b><small>{tx.label}</small></div><strong>{formatUnits(tx.amount)} <small>USDV</small></strong><div className="tx-status"><b>{tx.status === 'confirmed' ? `Confirmed · ${tx.latency} ms` : tx.status === 'unknown' ? 'Unknown · reconciling' : tx.status}</b>{tx.hash && <a href={`${EXPLORER_URL}/tx/${tx.hash}`} target="_blank" rel="noreferrer">{short(tx.hash)} ↗</a>}</div>{tx.note && <p className="tx-note">{tx.note}</p>}</article>)}</div>}
        {n && <details><summary>Accounts & verification details</summary><p>Vibenet chain {CHAIN_ID}. Measured latency is signing-to-verified-receipt, not finality. {r?.inferenceMs !== undefined ? `Last Jev inference: ${r.inferenceMs} ms.` : ''}</p>{(['player', 'jev', 'pot'] as const).map(side => <a key={side} href={`${EXPLORER_URL}/address/${n.runtime.accounts[side].account.address}`} target="_blank" rel="noreferrer">{name(side)}: {n.runtime.accounts[side].account.address} ↗</a>)}<button className="secondary" onClick={() => n.recheck()}>Recheck original receipts</button>{n.error && <p className="error">{n.error}</p>}</details>}
      </section>
    </main>
    <footer><span>ONE SECOND <i>/</i> A BASE VIBENET EXPERIMENT</span><nav><a href="../fighter/">Play the fighter ↗</a><a href="../200ms/">200ms stream ↗</a></nav></footer>
  </div>
}
