import { useEffect, useState } from 'react'
import { estimateLabel, SETUP_STEPS, type SetupProgress } from './loading.ts'

export default function LoadingScreen({ progress, error, retry }: { progress: SetupProgress; error: string; retry: () => void }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [])
  const current = SETUP_STEPS.findIndex(step => step.id === progress.phase)
  const step = SETUP_STEPS[current]
  return <div className="shell loading-shell">
    <header><span className="brand">ONE SECOND</span><span>Vibenet · Test money</span></header>
    <main className="loading-screen" aria-label="Setting up your game" aria-busy={!error}>
      <div className={`loading-symbol ${error ? 'paused' : ''}`} aria-hidden="true">✳</div>
      <div className="loading-announcement" role="status">
        <h1>{error ? 'A small detour.' : `${step.title}…`}</h1>
        <p className="loading-detail">{error ? 'Setup is paused. Your game will wait.' : progress.detail}</p>
      </div>
      <div className="loading-timing"><span>{error ? 'Paused' : estimateLabel(progress, now)}</span><small>{error ? 'Retry resumes the same wallets' : 'Estimate · faucet queues can vary'}</small></div>
      <ol className="loading-steps" aria-label="Wallet setup steps">
        {SETUP_STEPS.map((item, index) => {
          const state = index < current ? 'complete' : index === current ? (error ? 'paused' : 'active') : 'waiting'
          return <li key={item.id} data-step={item.id} data-state={state} aria-current={index === current ? 'step' : undefined}>
            <span className="step-marker" aria-hidden="true">{index < current ? '✓' : index + 1}</span>
            <span>{item.title}<small>{index < current ? 'Done' : index === current ? error ? 'Paused' : 'In progress' : 'Up next'}</small></span>
          </li>
        })}
      </ol>
      {error && <div className="setup-error"><p role="alert">{error}</p><button onClick={retry}>Retry</button></div>}
      <p className="loading-footnote">Keep this tab open. We’ll let you in when the wallets are ready.</p>
    </main>
  </div>
}
