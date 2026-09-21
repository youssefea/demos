import assert from 'node:assert/strict'
import { chromium } from 'playwright'

// Deterministic boundary mocks: no live faucet, model calls, or settlement.
const url = process.env.PREDICTION_URL ?? 'http://localhost:5175'
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_EXECUTABLE_PATH })
const errors = []
const timers = new Set()
const setupMock = `export class Setup { async run(progress) {
  window.setupCalls=(window.setupCalls||0)+1;
  window.advanceSetup=(phase,remainingSeconds=60)=>progress('Mock '+phase,{phase,detail:'Mock '+phase,at:Date.now(),remainingSeconds});
  window.advanceSetup('funding');
  return new Promise(resolve=>{window.finishSetup=()=>resolve({accounts:Object.fromEntries(['player','jev','pot'].map((side,i)=>[side,{account:{address:'0x'+String(i+1).repeat(40)}}]))})});
} }`
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
    let chainCalls = 0, aiCalls = 0, priceSockets = 0, failAI = false, price = 65000
    await page.route(/https:\/\/.*vibes\.base\.org\//, route => { chainCalls++; return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Intentional offline test"}' }) })
    await page.route('**/api/predict', async route => {
      aiCalls++; assert.deepEqual(Object.keys(route.request().postDataJSON()).sort(), ['ticks', 'version'])
      await new Promise(resolve => setTimeout(resolve, 100))
      return route.fulfill({ status: failAI ? 503 : 200, contentType: 'application/json', body: JSON.stringify(failAI ? { error: 'Jev unavailable' } : { pick: 'down', model: 'typesafe-ai/jev', inferenceMs: 100 }) })
    })
    await page.routeWebSocket('wss://ws-feed.exchange.coinbase.com', ws => {
      priceSockets++
      let id = 0, lastPrice, lastHeartbeat = 0
      ws.onMessage(message => assert.deepEqual(JSON.parse(String(message)).channels, ['matches', 'heartbeat']))
      const timer = setInterval(() => {
        const now = Date.now()
        // Only genuine price changes generate trades: quiet periods keep the feed live via heartbeat.
        if (price !== lastPrice) {
          ws.send(JSON.stringify({ type: id ? 'match' : 'last_match', product_id: 'BTC-USD', time: new Date(id ? now : now - 60_000).toISOString(), price: String(price), trade_id: ++id }))
          lastPrice = price
        }
        if (now - lastHeartbeat >= 1000) {
          ws.send(JSON.stringify({ type: 'heartbeat', product_id: 'BTC-USD', time: new Date(now).toISOString(), last_trade_id: id }))
          lastHeartbeat = now
        }
      }, 100)
      timers.add(timer)
      ws.onClose(() => { clearInterval(timer); timers.delete(timer) })
    })
    // Setup begins on landing, including its honest failure/retry path, without a click.
    await page.goto(url)
    await page.getByRole('button', { name: 'Retry', exact: true }).waitFor()
    assert.ok(chainCalls > 0); assert.equal(aiCalls, 0)
    assert.ok(await page.getByRole('alert').textContent())
    assert.equal(await page.getByRole('button', { name: /Set up|Start/ }).count(), 0)
    assert.equal(priceSockets, 0, 'No market subscription before setup succeeds')
    assert.equal(await page.locator('.market,.balances,.picks').count(), 0, 'Failed setup never reveals the game')
    await page.getByRole('button', { name: 'Retry', exact: true }).click()
    await page.getByRole('button', { name: 'Retry', exact: true }).waitFor()
    await page.route(/\/src\/setup\.ts(?:\?.*)?$/, route => route.fulfill({ contentType: 'application/javascript', body: setupMock }))
    await page.route(/\/src\/network\.ts(?:\?.*)?$/, route => route.fulfill({ contentType: 'application/javascript', body: networkMock }))
    await page.reload()
    await page.getByRole('heading', { name: 'Making you test-rich…', exact: true }).waitFor()
    assert.equal(await page.locator('.market,.balances,.picks').count(), 0, 'Loading screen replaces the whole game')
    assert.equal(priceSockets, 0); assert.equal(aiCalls, 0)
    assert.equal(await page.locator('.loading-steps [data-state="complete"]').count(), 2)
    assert.match(await page.locator('.loading-timing').innerText(), /About .*seconds left/)
    await page.screenshot({ path: `/tmp/one-second-loader-${width}.png`, fullPage: true })
    await page.evaluate(() => window.advanceSetup('deploy', 15))
    await page.getByRole('heading', { name: 'Onchaining the squad…', exact: true }).waitFor()
    assert.equal(await page.locator('.loading-steps [data-state="complete"]').count(), 3)
    await page.evaluate(() => window.advanceSetup('verify', 5))
    await page.getByRole('heading', { name: 'Counting the pretend money…', exact: true }).waitFor()
    assert.equal(await page.locator('.market').count(), 0, 'Even verification is still behind the gate')
    await page.evaluate(() => window.finishSetup())
    await page.waitForFunction(() => document.querySelector('.pick:not(:disabled)'))
    assert.equal(await page.locator('.loading-screen').count(), 0)
    assert.equal(priceSockets, 1, 'Subscribe once after real setup completion')
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
    await page.getByRole('status').filter({ hasText: 'Both picked Down — refunded.' }).waitFor()
    assert.match(await page.locator('.round-picks').innerText(), /You ↓ Down.*Jev ↓ Down.*100 ms AI/)
    assert.equal(await page.locator('.history .tx').count(), 7)
    assert.equal(await page.locator('.activity .tx').count(), 3, 'Only three compact transactions visible')
    assert.equal(await page.locator('.balance-row').first().locator('strong').textContent(), '21.00')
    await page.screenshot({ path: `/tmp/one-second-simple-${width}.png`, fullPage: true })
    // A completely quiet market is a flat draw, never an artificial late-feed void.
    await up.click()
    await page.getByRole('status').filter({ hasText: 'BTC stayed flat — refunded.' }).waitFor()
    assert.equal(await page.locator('.history .tx').count(), 11)
    assert.equal(await page.locator('.balance-row').first().locator('strong').textContent(), '21.00')
    failAI = true; await up.click()
    await page.getByRole('status').filter({ hasText: 'No bet placed. Try again.' }).waitFor()
    assert.equal(await page.locator('.history .tx').count(), 11)
    assert.equal(aiCalls, 4)
    assert.equal(await page.evaluate(() => window.setupCalls), 1, 'Rerenders and rounds never re-fund accounts')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await page.close()
    console.log(`PASS ${width}px: automatic setup/retry, direct Up/Down, payout/same-pick/quiet-market refunds, ready for next tap, outage, compact above-fold controls`)
  }
  assert.deepEqual(errors, [])
  console.log('PASS mocked browser smoke. No live transactions or model decisions tested.')
} finally { for (const timer of timers) clearInterval(timer); await browser.close() }
