import assert from 'node:assert/strict'
import { chromium } from 'playwright'

// Deterministic boundary mocks: no live faucet, model calls, or settlement.
const url = process.env.PREDICTION_URL ?? 'http://localhost:5175'
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_EXECUTABLE_PATH })
const errors = []
const timers = new Set()
const setupMock = `export class Setup { async run(progress) { window.setupCalls=(window.setupCalls||0)+1; progress('Mock funding'); await new Promise(r=>setTimeout(r,100)); return { accounts: Object.fromEntries(['player','jev','pot'].map((side,i)=>[side,{account:{address:'0x'+String(i+1).repeat(40)}}])) } } }`
const networkMock = `import { Ledger } from '/src/ledger.ts';
export class PredictionNetwork {
  state='MOCK WSS'; error=null; head=123; blocked=null;
  ledger=new Ledger({player:20000000n,jev:20000000n,pot:0n});
  constructor(runtime,change){this.runtime=runtime;this.change=change}
  send(round,from,to,amount,label){const tx=this.ledger.create(round,from,to,amount,label,performance.now());this.ledger.register(tx,'0x'+tx.id.toString(16).padStart(64,'0'));setTimeout(()=>{this.ledger.confirm(tx,123,performance.now());this.change()},100);return tx}
  recheck(){} close(){}
}`
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 900 }, reducedMotion: 'reduce' })
    page.on('pageerror', error => errors.push(error.message))
    let chainCalls = 0, aiCalls = 0, failAI = false, price = 65000
    await page.route(/https:\/\/.*vibes\.base\.org\//, route => { chainCalls++; return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Intentional offline test"}' }) })
    await page.route('**/api/predict', async route => {
      aiCalls++; assert.deepEqual(Object.keys(route.request().postDataJSON()).sort(), ['ticks', 'version'])
      await new Promise(resolve => setTimeout(resolve, 100))
      return route.fulfill({ status: failAI ? 503 : 200, contentType: 'application/json', body: JSON.stringify(failAI ? { error: 'Jev unavailable' } : { pick: 'down', model: 'typesafe-ai/jev', inferenceMs: 100 }) })
    })
    await page.routeWebSocket('wss://ws-feed.exchange.coinbase.com', ws => {
      let id = 0
      const timer = setInterval(() => ws.send(JSON.stringify({ type: 'ticker', product_id: 'BTC-USD', time: new Date().toISOString(), price: String(price), trade_id: ++id })), 100)
      timers.add(timer)
      ws.onClose(() => { clearInterval(timer); timers.delete(timer) })
    })
    // Setup begins on landing, including its honest failure/retry path, without a click.
    await page.goto(url)
    await page.getByRole('button', { name: 'Retry', exact: true }).waitFor()
    assert.ok(chainCalls > 0); assert.equal(aiCalls, 0)
    assert.ok(await page.getByRole('alert').textContent())
    assert.equal(await page.getByRole('button', { name: /Set up|Start/ }).count(), 0)
    await page.getByRole('button', { name: 'Retry', exact: true }).click()
    await page.getByRole('button', { name: 'Retry', exact: true }).waitFor()
    await page.route(/\/src\/setup\.ts(?:\?.*)?$/, route => route.fulfill({ contentType: 'application/javascript', body: setupMock }))
    await page.route(/\/src\/network\.ts(?:\?.*)?$/, route => route.fulfill({ contentType: 'application/javascript', body: networkMock }))
    await page.reload()
    await page.waitForFunction(() => document.querySelector('.pick:not(:disabled)'))
    const up = page.getByRole('button', { name: 'Up', exact: true }), down = page.getByRole('button', { name: 'Down', exact: true })
    assert.equal(await page.evaluate(() => window.setupCalls), 1)
    assert.equal(aiCalls, 0, 'Idle/setup does not keep asking the model or place bets')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    assert.ok((await down.boundingBox()).y + (await down.boundingBox()).height < page.viewportSize().height, 'Direction buttons are above the fold')
    assert.equal(await page.locator('.history .tx').count(), 0)
    await page.screenshot({ path: `/tmp/one-second-simple-ready-${width}.png`, fullPage: true })
    // One tap, no Start and no second confirmation.
    await up.click()
    await page.getByRole('status').filter({ hasText: 'Watching the next second…' }).waitFor()
    price = 65001
    await page.getByRole('status').filter({ hasText: 'You won $1. Go again.' }).waitFor()
    assert.equal(await page.locator('.history .tx').count(), 3)
    assert.equal(await page.locator('.balance-row').first().locator('strong').textContent(), '21.00')
    assert.equal(await page.getByTestId('pot-balance').textContent(), '0.00')
    await page.waitForTimeout(400); assert.equal(aiCalls, 1, 'Settled rounds do not automatically wager again')
    await down.click()
    await page.getByRole('status').filter({ hasText: 'Refunded. Go again.' }).waitFor()
    assert.equal(await page.locator('.history .tx').count(), 7)
    assert.equal(await page.locator('.activity .tx').count(), 3, 'Only three compact transactions visible')
    assert.equal(await page.locator('.balance-row').first().locator('strong').textContent(), '21.00')
    await page.screenshot({ path: `/tmp/one-second-simple-${width}.png`, fullPage: true })
    failAI = true; await up.click()
    await page.getByRole('status').filter({ hasText: 'No bet placed. Try again.' }).waitFor()
    assert.equal(await page.locator('.history .tx').count(), 7)
    assert.equal(aiCalls, 3)
    assert.equal(await page.evaluate(() => window.setupCalls), 1, 'Rerenders and rounds never re-fund accounts')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await page.close()
    console.log(`PASS ${width}px: automatic setup/retry, direct Up/Down, payout/refund, ready for next tap, outage, compact above-fold controls`)
  }
  assert.deepEqual(errors, [])
  console.log('PASS mocked browser smoke. No live transactions or model decisions tested.')
} finally { for (const timer of timers) clearInterval(timer); await browser.close() }
