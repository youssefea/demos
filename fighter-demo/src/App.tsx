import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { CHAIN_ID, EXPLORER_URL } from '../../200ms-demo/src/chain/config'
import { Combat, emptyInput, MAX_HP, type Input } from './combat'
import { formatUnits, HIT_UNITS, MATCH_LIMIT, type Side } from './ledger'
import { ArenaNetwork } from './network'
import { Renderer } from './renderer'
import { Setup } from './setup'
import { combatSnapshot, JevController, requestDecision } from './jev'

type Mode = 'idle' | 'setup' | 'ready' | 'playing' | 'paused' | 'finished' | 'error'
const name = (side: Side) => side === 'player' ? 'YOU' : 'JEV'
const short = (hash: string) => `${hash.slice(0, 6)}…${hash.slice(-4)}`
export default function App() {
  const [mode, updateMode] = useState<Mode>('idle')
  const modeRef = useRef<Mode>('idle')
  const [progress, setProgress] = useState('')
  const [setupError, setSetupError] = useState('')
  const [sound, setSound] = useState(false)
  const soundRef = useRef(false)
  const audio = useRef<AudioContext | null>(null)
  const [, redraw] = useState(0)
  const canvas = useRef<HTMLCanvasElement>(null)
  const game = useRef(new Combat())
  const input = useRef(emptyInput())
  const jev = useRef<JevController | null>(null)
  const renderer = useRef<Renderer | null>(null)
  const network = useRef<ArenaNetwork | null>(null)
  const setup = useRef(new Setup())
  const live = useRef(true)
  const change = () => { if (live.current) redraw(v => v + 1) }
  const setMode = (next: Mode) => { modeRef.current = next; updateMode(next); input.current = emptyInput(); if (next !== 'playing') jev.current?.suspend() }
  const beep = (confirmed: boolean) => {
    if (!soundRef.current || !audio.current) return
    const a = audio.current, oscillator = a.createOscillator(), gain = a.createGain()
    oscillator.type = confirmed ? 'sine' : 'square'
    oscillator.frequency.setValueAtTime(confirmed ? 740 : 160, a.currentTime)
    oscillator.frequency.exponentialRampToValueAtTime(confirmed ? 1_000 : 65, a.currentTime + .07)
    gain.gain.setValueAtTime(.025, a.currentTime); gain.gain.exponentialRampToValueAtTime(.001, a.currentTime + .08)
    oscillator.connect(gain).connect(a.destination); oscillator.start(); oscillator.stop(a.currentTime + .09)
  }
  const pause = () => { if (modeRef.current === 'playing') setMode('paused'); input.current = emptyInput() }
  useEffect(() => {
    live.current = true
    renderer.current = new Renderer(canvas.current!)
    jev.current = new JevController(requestDecision(import.meta.env.VITE_JEV_API_URL || 'https://block-fighter-jev.vercel.app/api/decide'))
    let raf = 0, last = performance.now(), lastUi = 0
    const frame = (now: number) => {
      const dt = now - last; last = now
      const n = network.current, g = game.current
      if (modeRef.current === 'playing' && n && n.ledger.matchCount >= MATCH_LIMIT) g.finish()
      // Model scheduling uses wall time and runs even while combat waits for a fresh decision.
      jev.current?.tick(modeRef.current === 'playing' && !!n && !n.blocked && !g.finished && g.countdown === 0 && !document.hidden, () => combatSnapshot(g))
      if (modeRef.current === 'playing' && n) {
        if (!n.blocked && (g.countdown > 0 || jev.current?.view.status === 'live')) {
          g.step(dt, input.current, victim => n.hit(victim), event => { renderer.current?.event(event); if (event.kind === 'hit') beep(false) }, jev.current?.input(g.fighters.player.x, g.fighters.bot.x))
        }
        if (g.finished) setMode('finished')
      }
      if (!document.hidden) renderer.current?.draw(g, now, ['idle', 'setup', 'error', 'ready'].includes(modeRef.current))
      if (now - lastUi > 100 && modeRef.current === 'playing') { lastUi = now; change() }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    const mapping: Record<string, keyof Input> = { KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right', KeyJ: 'punch', KeyK: 'kick', KeyL: 'block' }
    const down = (e: KeyboardEvent) => {
      if (modeRef.current !== 'playing') return
      if (e.code === 'Escape' || e.code === 'KeyP') { e.preventDefault(); pause(); return }
      if (mapping[e.code] && canvas.current?.closest('.cabinet')?.contains(document.activeElement)) { e.preventDefault(); input.current[mapping[e.code]] = true }
    }
    const up = (e: KeyboardEvent) => { if (mapping[e.code]) input.current[mapping[e.code]] = false }
    const hidden = () => { if (document.hidden) pause() }
    window.addEventListener('keydown', down); window.addEventListener('keyup', up)
    window.addEventListener('blur', pause); document.addEventListener('visibilitychange', hidden)
    return () => {
      live.current = false; jev.current?.dispose(); cancelAnimationFrame(raf); network.current?.close(); void audio.current?.close()
      window.removeEventListener('keydown', down); window.removeEventListener('keyup', up)
      window.removeEventListener('blur', pause); document.removeEventListener('visibilitychange', hidden)
    }
  }, [])
  const initialize = async () => {
    if (modeRef.current === 'setup') return
    setSetupError(''); setMode('setup')
    try {
      const runtime = await setup.current.run(label => { if (live.current) setProgress(label) })
      if (!live.current) return
      network.current?.close()
      network.current = new ArenaNetwork(runtime, change, tx => { renderer.current?.confirm(tx, game.current); beep(true) })
      setMode('ready')
    } catch (error) {
      if (live.current) { setSetupError(error instanceof Error ? error.message : 'Setup unavailable'); setMode('error') }
    }
  }
  const play = () => { setMode('playing'); canvas.current?.focus(); void audio.current?.resume() }
  const rematch = () => {
    if (!network.current?.ledger.newMatch()) return
    jev.current?.reset(); game.current = new Combat(); play()
  }
  const toggleSound = () => {
    const next = !soundRef.current
    if (next && !audio.current) audio.current = new AudioContext()
    if (next) void audio.current?.resume()
    soundRef.current = next; setSound(next)
  }
  const press = (key: keyof Input, e: PointerEvent<HTMLButtonElement>) => {
    if (modeRef.current !== 'playing') return
    e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); input.current[key] = true
  }
  const n = network.current, ledger = n?.ledger, g = game.current
  const confirmed = ledger?.confirmed ?? []
  const latency = confirmed.length ? Math.round(confirmed.reduce((sum, t) => sum + (t.latency ?? 0), 0) / confirmed.length) : null
  const rows = ledger?.transfers.slice(-8).reverse() ?? []
  const net = ledger ? ledger.balances.player - n!.runtime.balances.player : 0n
  const active = ['playing', 'paused', 'finished'].includes(mode)
  const blocked = n?.blocked
  const ai = jev.current?.view
  const aiStatus = mode === 'playing' && g.countdown > 0 ? 'countdown' : mode === 'playing' ? ai?.status ?? 'waiting' : mode === 'paused' ? 'paused' : mode === 'finished' ? 'round over' : 'not connected'
  const control = (key: keyof Input, label: string, hint: string, className = '') => <button type="button" className={`pad ${className}`} aria-label={label} onPointerDown={e => press(key, e)} onPointerUp={() => { input.current[key] = false }} onPointerCancel={() => { input.current[key] = false }} onLostPointerCapture={() => { input.current[key] = false }} onKeyDown={e => { if ((e.key === ' ' || e.key === 'Enter') && modeRef.current === 'playing') { e.preventDefault(); input.current[key] = true } }} onKeyUp={() => { input.current[key] = false }} disabled={mode !== 'playing'}><b>{hint}</b><span>{label}</span></button>
  return <div className="app-shell">
    <header className="site-header">
      <a className="brand" href="./" aria-label="Block Fighter home"><span className="brand-mark" aria-hidden="true">B<span>F</span></span><span>BLOCK FIGHTER<small>THE ONCHAIN ARCADE</small></span></a>
      <div className="header-right"><span className="test-badge">TESTNET ONLY</span><span className="base-word"><i aria-hidden="true" /> Built on Base</span></div>
    </header>
    <main>
      <section className="intro" aria-labelledby="title">
        <div><div className="eyebrow"><span className="blue-line" /> SPEED YOU CAN FEEL</div><h1 id="title">Every hit. <span>Onchain.</span></h1><p>You vs Jev, a decision-model opponent. Every landed hit moves test money.</p></div>
        <div className="intro-note"><span className="mini-coin">$</span><div><strong>LAND A HIT. MOVE 0.05.</strong><small>Vibenet test USDV. Never real money.</small></div></div>
      </section>
      <div className="game-layout">
        <section className="game-column" aria-label="Fighting game">
          <div className="cabinet" onBlur={e => { if (!e.relatedTarget || !e.currentTarget.contains(e.relatedTarget as Node)) pause() }}>
            <div className="cabinet-top"><span><i className="tiny-square" /> ROOFTOP RUMBLE</span><span>YOU <b>VS</b> JEV <span className="stage-number"> / STAGE 01</span></span></div>
            <div className="arena">
              <canvas ref={canvas} width="640" height="360" tabIndex={0} aria-label="Block Fighter arena. A and D move, J punch, K kick, L block, P pause. Health and timer are shown above the arena." />
              <div className="hud" aria-label="Round status">
                <div className="fighter-hud"><div className="fighter-label"><strong><span className="player-dot" /> YOU</strong><span>BLUE CORNER</span></div><div className="health" role="meter" aria-label="Your health" aria-valuenow={g.fighters.player.hp} aria-valuemin={0} aria-valuemax={MAX_HP}><i style={{ width: `${g.fighters.player.hp / MAX_HP * 100}%` }} /></div><div className="hud-funds">{ledger ? formatUnits(ledger.balances.player) : '—'} <span>USDV</span></div></div>
                <div className="timer"><span>ROUND 01</span><b>{Math.ceil(g.remaining / 1000).toString().padStart(2, '0')}</b><small>SECONDS</small></div>
                <div className="fighter-hud bot-hud"><div className="fighter-label"><span>ORANGE CORNER</span><strong>JEV <span className="player-dot" /></strong></div><div className="health" role="meter" aria-label="Jev health" aria-valuenow={g.fighters.bot.hp} aria-valuemin={0} aria-valuemax={MAX_HP}><i style={{ width: `${g.fighters.bot.hp / MAX_HP * 100}%` }} /></div><div className="hud-funds">{ledger ? formatUnits(ledger.balances.bot) : '—'} <span>USDV</span></div></div>
              </div>
              {mode === 'playing' && g.countdown > 0 && !blocked && <div className="countdown" aria-live="off">{g.countdown > 900 ? 'READY?' : 'FIGHT!'}</div>}
              {mode === 'playing' && blocked && <div className="network-hold"><span className="spinner" /><strong>HOLD THAT PUNCH</strong><p>{blocked}</p><button onClick={() => n?.retry()}>Check receipts</button></div>}
              {mode === 'playing' && g.countdown === 0 && !blocked && ai?.status !== 'live' && <div className="network-hold jev-hold"><span className="spinner" /><strong>{ai?.status === 'unavailable' ? 'JEV UNAVAILABLE' : 'JEV IS THINKING'}</strong><p>Combat paused until a fresh model decision.<br />{ai?.status === 'unavailable' ? 'Retrying automatically. No scripted fallback.' : 'The real Jev model is choosing its next move.'}</p></div>}
              {mode !== 'playing' && <div className={`arena-overlay ${active ? 'dimmed' : ''}`}>
                <div className="overlay-card">
                  {mode === 'idle' && <><span className="pixel-kicker">INSERT ABSOLUTELY NO COINS</span><h2>BLOCK<br /><span>FIGHTER</span><sup>01</sup></h2><p>Fight Jev. Real AI decisions. Real testnet transfers.</p><button className="primary start" onClick={() => void initialize()}>ENTER THE ARENA <span>↗</span></button><small>No wallet needed · Two local test accounts</small></>}
                  {mode === 'setup' && <><span className="pixel-kicker">PREPARING BOTH CORNERS</span><h2 className="smaller">GEARING UP<span className="loading-dots">...</span></h2><div className="setup-track"><i /></div><p className="setup-progress" role="status">{progress}</p><small>Faucet cooldowns can take a minute. No real money.</small></>}
                  {mode === 'error' && <><span className="pixel-kicker">NETWORK TIMEOUT, NOT A KNOCKOUT</span><h2 className="smaller">TAKE A BREATHER</h2><p className="setup-progress" role="alert">{setupError}</p><button className="primary" onClick={() => void initialize()}>RETRY SETUP ↻</button><small>Same local accounts. No simulated fallback.</small></>}
                  {mode === 'ready' && <><span className="pixel-kicker">BOTH ACCOUNTS FUNDED</span><h2 className="smaller">YOU'RE UP.</h2><p>Close the gap with D. Hold J or K to attack.<br />L blocks hits — and their transfers.</p><button className="primary" onClick={play}>LET'S FIGHT →</button><small>60 seconds · 0.05 test USDV per landed hit</small></>}
                  {mode === 'paused' && <><span className="pixel-kicker">TAKE YOUR TIME</span><h2 className="smaller">PAUSED.</h2><p>No new hits. Submitted transfers still settle.</p><button className="primary" onClick={play}>BACK TO THE FIGHT →</button></>}
                  {mode === 'finished' && <><span className="pixel-kicker">{g.remaining === 0 ? 'TIME’S UP' : 'ROUND COMPLETE'}</span><h2 className="smaller">{g.winner === 'draw' ? 'A FAIR FIGHT.' : g.winner === 'player' ? 'YOU WIN!' : 'JEV WINS.'}</h2><p>{g.hits.player} hits landed · {g.hits.bot} taken<br />Your confirmed net: {net > 0n ? '+' : ''}{formatUnits(net)} test USDV</p><button className="primary" disabled={Boolean(ledger?.unresolved.length) || (ledger?.transfers.length ?? 0) >= 1_000} onClick={rematch}>{ledger?.unresolved.length ? 'WAITING FOR SETTLEMENT…' : 'RUN IT BACK ↻'}</button><small>Balances only change on validated confirmations.</small></>}
                </div>
              </div>}
              <div className="arena-bottom"><span><i /> VIBENET TEST ARENA</span><span>NO REAL MONEY</span></div>
            </div>
            <div className="control-deck">
              <div className="control-group">{control('left', 'Move left', 'A ←')}{control('right', 'Move right', 'D →')}</div>
              <div className="control-group actions">{control('punch', 'Punch', 'J', 'punch-pad')}{control('kick', 'Kick', 'K', 'kick-pad')}{control('block', 'Block', 'L', 'block-pad')}</div>
              <div className="utilities"><button className="utility" aria-label={sound ? 'Mute game sound' : 'Enable game sound'} aria-pressed={sound} onClick={toggleSound}>{sound ? '♪ ON' : '♪ OFF'}</button><button className="utility" disabled={mode !== 'playing' && mode !== 'paused'} onClick={mode === 'paused' ? play : pause} aria-label={mode === 'paused' ? 'Resume game' : 'Pause game'}>{mode === 'paused' ? '▶' : 'Ⅱ'} <span>PAUSE</span></button></div>
            </div>
          </div>
          <div className="jev-status" aria-label="Jev decision model status" aria-live="off">
            <div><strong><i className={`status-dot ${aiStatus === 'live' ? 'connected' : ''}`} /> JEV</strong><span>{aiStatus}{ai?.action && aiStatus === 'live' ? ` · ${ai.action}` : ''}</span><span>{ai?.metrics ? `Last inference ${ai.metrics.inferenceMs} ms · round trip ${ai.metrics.roundTripMs} ms` : 'Inference — · round trip —'}</span></div>
            <p>TypeSafe AI decision model via Vercel AI SDK · not a scripted bot. AI latency is separate from the 200ms network target.</p>
          </div>
          <div className="game-hint"><span><b>PRO TIP</b> Hold to throw. Get close. Block to keep your balance.</span><span>P / ESC to pause</span></div>
          <div className="stats-row">
            <div><span className="stat-label">CONFIRMED VOLUME <i>↗</i></span><strong>{formatUnits(BigInt(confirmed.length) * HIT_UNITS)}<small> USDV</small></strong><span className="stat-detail">Test tokens moved, both directions</span></div>
            <div><span className="stat-label">HIT → CONFIRM <i>ϟ</i></span><strong>{latency ?? '—'}<small> ms</small></strong><span className="stat-detail">Client-observed average · not a guarantee</span></div>
            <div><span className="stat-label">ONCHAIN HITS <i>✳</i></span><strong>{confirmed.length.toString().padStart(2, '0')}<small> / {ledger?.transfers.length ?? 0}</small></strong><span className="stat-detail">Confirmed / attempted transfers</span></div>
          </div>
        </section>
        <aside className="feed-panel" aria-labelledby="feed-title">
          <div className="feed-heading"><div className="eyebrow">THE OTHER HALF OF THE FIGHT</div><h2 id="feed-title">Live transactions <span className={`status-dot ${n && !blocked ? 'connected' : ''}`} /></h2><p>Every landed hit moves <b>0.05 USDV</b><br />from the fighter hit to the attacker.</p></div>
          <div className="network-strip"><span><i className={`status-dot ${n && !blocked ? 'connected' : ''}`} /> {n ? blocked ? 'Catching up' : n.state : 'Not connected'}</span><b>{n ? `#${n.head.toLocaleString()}` : '—'}</b></div>
          <div className="feed-list" aria-live="off" aria-label="Recent transfers, newest first">
            {!rows.length ? <div className="feed-empty"><div className="empty-pixels" aria-hidden="true">↔</div><strong>THE FIRST HIT IS YOURS.</strong><p>{mode === 'idle' ? 'Enter the arena. Land a punch.\nWatch the transaction fly.' : 'No hit transfers yet.\nYour next punch could change that.'}</p><span>NO HITS. NO TRANSFERS.</span></div> : rows.map(tx => <div className={`tx-row ${tx.status}`} key={tx.id}>
              <span className={`tx-icon ${tx.attacker}`}>{tx.attacker === 'player' ? '↙' : '↗'}</span>
              <div className="tx-main"><div><b>{name(tx.victim)} <span>→</span> {name(tx.attacker)}</b><strong>0.05 <small>USDV</small></strong></div><div className="tx-meta"><span>{tx.status === 'signing' ? 'Signing' : tx.status === 'pending' ? 'Pending' : tx.status === 'confirmed' ? `Confirmed · ${tx.latency} ms` : tx.status === 'unknown' ? 'Unknown · reconciling' : 'Failed · no transfer'}</span>{tx.hash && <a href={`${EXPLORER_URL}/tx/${tx.hash}`} target="_blank" rel="noreferrer" onClick={pause} aria-label={`View transaction ${tx.hash}`}>{short(tx.hash)} ↗</a>}</div>{tx.note && <p className="tx-note" title={tx.note}>{tx.note}</p>}</div>
            </div>)}
          </div>
          <div className="feed-summary"><span><i className="status-dot connected" /> {confirmed.length} confirmed</span><span>{ledger?.unresolved.length ?? 0} unresolved</span></div>
          <div className="speed-note"><span className="speed-symbol">ϟ</span><div><strong>200ms is the network target.</strong><p>What you see is measured hit-to-confirm time in this browser. Real network. Real latency. Test money.</p></div></div>
          {n && <details className="accounts"><summary>Two fighters. Two local accounts. ↗</summary><p>Ephemeral browser keys · chain {CHAIN_ID}<br />Never deposit real funds. Reloading discards keys.</p>{(['player', 'bot'] as const).map(side => <a key={side} href={`${EXPLORER_URL}/address/${n.runtime.accounts[side].account.address}`} target="_blank" rel="noreferrer" onClick={pause}>{name(side)}: {short(n.runtime.accounts[side].account.address)} ↗</a>)}<p>8 in flight · 12 USDV / round · 50 USDV / session. Unknown transfers stop combat and keep reconciling.</p><button onClick={() => n.retry()}>Recheck unresolved receipts</button></details>}
        </aside>
      </div>
      <section className="how-it-works" aria-label="How it works"><div><span>01</span><p><strong>Throw a punch.</strong><small>Or a kick. We're not picky.</small></p></div><i>→</i><div><span>02</span><p><strong>Move test money.</strong><small>0.05 USDV per unblocked hit.</small></p></div><i>→</i><div><span>03</span><p><strong>See it settle.</strong><small>No wallet popups. Just the fight.</small></p></div></section>
    </main>
    <footer><span>BLOCK FIGHTER <i>/</i> A BASE VIBENET EXPERIMENT</span><span>Original pixels. Real testnet transactions. <a href="../200ms/">Try the 200ms stream ↗</a></span></footer>
  </div>
}
