import assert from 'node:assert/strict'
import { chromium } from 'playwright'

// DETERMINISTIC MOCKS: no faucet, no live Jev calls and no chain settlement.
// Run against Vite dev (npm run dev), because mocks intercept source module boundaries.
const url = process.env.PREDICTION_URL ?? 'http://localhost:5175'
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_EXECUTABLE_PATH })
const errors = []
const setupMock = `export class Setup { async run(progress) { progress('Mock setup'); return { accounts: Object.fromEntries(['player','jev','pot'].map((side,i) => [side, { account: { address: '0x' + String(i+1).repeat(40) } }])) } } }`
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
    const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 1080 }, reducedMotion: 'reduce' })
    page.on('pageerror', error => errors.push(error.message))
    let chainCalls = 0, aiCalls = 0, failAI = false, price = 65000, timer
    await page.route(/https:\/\/.*vibes\.base\.org\//, route => { chainCalls++; return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Intentional offline test"}' }) })
    await page.route('**/api/predict', async route => {
      aiCalls++; const body = route.request().postDataJSON(); assert.deepEqual(Object.keys(body).sort(), ['ticks', 'version'])
      await new Promise(resolve => setTimeout(resolve, 100))
      return route.fulfill({ status: failAI ? 503 : 200, contentType: 'application/json', body: JSON.stringify(failAI ? { error: 'Jev unavailable' } : { pick: 'down', model: 'typesafe-ai/jev', inferenceMs: 100 }) })
    })
    await page.routeWebSocket('wss://ws-feed.exchange.coinbase.com', ws => {
      let id = 0
      const socketTimer = setInterval(() => ws.send(JSON.stringify({ type: 'ticker', product_id: 'BTC-USD', time: new Date().toISOString(), price: String(price), trade_id: ++id })), 100)
      timer = socketTimer
      ws.onClose(() => clearInterval(socketTimer))
    })
    await page.goto(url); await page.getByRole('button', { name: 'Set up test accounts', exact: true }).waitFor()
    await page.waitForTimeout(300); assert.equal(chainCalls, 0); assert.equal(aiCalls, 0)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await page.getByRole('button', { name: 'Set up test accounts', exact: true }).click()
    await page.getByRole('button', { name: 'Retry setup', exact: true }).waitFor()
    assert.ok(chainCalls > 0); assert.equal(aiCalls, 0)
    assert.ok(await page.getByRole('alert').textContent())
    // Replace only boundary modules; the real React UI, price parser and round controller remain running.
    await page.route(/\/src\/setup\.ts(?:\?.*)?$/,  route => route.fulfill({ contentType: 'application/javascript', body: setupMock }))
    await page.route(/\/src\/network\.ts(?:\?.*)?$/,  route => route.fulfill({ contentType: 'application/javascript', body: networkMock }))
    await page.reload(); await page.getByRole('button', { name: 'Set up test accounts', exact: true }).click()
    const start = page.getByRole('button', { name: 'Start a $1 test round →', exact: true })
    await page.waitForTimeout(300); await start.click()
    const up = page.getByRole('button', { name: '↗ Up BTC goes higher', exact: true })
    await up.waitFor(); await up.click()
    await page.getByText('One-second price window is live.', { exact: true }).waitFor()
    price = 65001
    await page.getByText('You won 1.00 test USDV net. Payout confirmed.', { exact: true }).waitFor()
    assert.equal(await page.locator('.tx').count(), 3)
    assert.equal(await page.locator('.balance-row').first().locator('strong').textContent(), '21.00')
    assert.equal(await page.locator('.balance-row').last().locator('strong').textContent(), '0.00')
    await page.screenshot({ path: `/tmp/one-second-${width}.png`, fullPage: true })
    await start.click(); await page.getByRole('button', { name: '↘ Down BTC goes lower', exact: true }).click()
    await page.getByText('Same prediction. Both stakes are returned. Refunds confirmed.', { exact: true }).waitFor()
    assert.equal(await page.locator('.tx').count(), 7)
    assert.equal(await page.locator('.balance-row').first().locator('strong').textContent(), '21.00')
    failAI = true; await start.click()
    await page.getByText('Jev unavailable. No stakes submitted. Try another round.', { exact: true }).waitFor()
    assert.equal(await page.locator('.tx').count(), 7)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    assert.equal(aiCalls, 3)
    clearInterval(timer); await page.close()
    console.log(`PASS ${width}px: MOCKED payout, matching-pick refunds, provider outage, responsive layout, no prestart AI/funding; real offline setup failure`)
  }
  assert.deepEqual(errors, []); console.log('PASS deterministic browser smoke. NO live transactions or model decisions tested.')
} finally { await browser.close() }
