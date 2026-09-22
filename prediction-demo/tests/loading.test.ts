import test from 'node:test'
import assert from 'node:assert/strict'
import { estimateLabel, fundingEstimate, SETUP_STEPS, type SetupProgress } from '../src/loading.ts'

test('three-check funding estimate uses the advertised faucet cooldown and unfinished work', () => {
  assert.equal(fundingEstimate(3, 10), 51)
  assert.ok(fundingEstimate(2, 10) < fundingEstimate(3, 10))
  assert.ok(fundingEstimate(3, 20) > fundingEstimate(3, 10))
  assert.ok(Number.isFinite(fundingEstimate(3, NaN)))
  assert.equal(fundingEstimate(0, 10), 12)
})
test('ETA counts down as an estimate, never claims zero seconds or completion', () => {
  const progress: SetupProgress = { phase: 'funding', detail: 'Getting coins', at: 1000, remainingSeconds: 60 }
  assert.equal(estimateLabel(progress, 1000), 'About 50–70 seconds left')
  assert.equal(estimateLabel(progress, 21000), 'About 30–50 seconds left')
  assert.equal(estimateLabel(progress, 56000), 'About 10 seconds left')
  assert.equal(estimateLabel(progress, 61000), 'Taking a little longer than estimated')
  assert.equal(estimateLabel(progress, 999999), 'Taking a little longer than estimated')
  assert.equal(progress.phase, 'funding', 'Elapsed time cannot advance the actual setup stage')
})
test('initial estimates and backward clocks are safe', () => {
  const progress: SetupProgress = { phase: 'connect', detail: 'Checking', at: 1000 }
  assert.equal(estimateLabel(progress, 999999), 'Usually about a minute')
  assert.equal(estimateLabel({ ...progress, remainingSeconds: 60 }, 0), 'About 50–70 seconds left')
})
test('setup steps are ordered by actual work, ending with balance verification', () => {
  assert.deepEqual(SETUP_STEPS.map(s => s.id), ['connect', 'accounts', 'funding', 'deploy', 'verify'])
})
