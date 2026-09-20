import assert from 'node:assert/strict'
import { chromium } from 'playwright'

// Intentional OFFLINE setup failure test, not evidence of live transfer success.
// Run the dev server first. No faucet is called, no synthetic confirmation injected.
const base = process.env.FIGHTER_URL ?? 'http://localhost:5174'
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_EXECUTABLE_PATH })
const errors = []
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 1100 }, reducedMotion: 'reduce' })
    page.on('pageerror', error => errors.push(error.message))
    let networkCalls = 0
    await page.route(/https:\/\/.*vibes\.base\.org\//, route => {
      networkCalls++
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Offline smoke test: Vibenet unavailable' }) })
    })
    await page.goto(base)
    await page.getByRole('button', { name: 'ENTER THE ARENA' }).waitFor()
    await page.waitForTimeout(350)
    assert.equal(networkCalls, 0, 'No prestart chain activity')
    assert.equal(await page.locator('canvas').count(), 1)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'No horizontal overflow')
    const colors = await page.locator('canvas').evaluate(canvas => {
      const data = canvas.getContext('2d').getImageData(0, 0, 640, 360).data
      return new Set(Array.from({ length: 640 * 360 }, (_, i) => `${data[i * 4]},${data[i * 4 + 1]},${data[i * 4 + 2]}`)).size
    })
    assert.ok(colors > 50, 'Pixel art rendered')
    await page.screenshot({ path: `/tmp/block-fighter-${width}.png`, fullPage: true })
    await page.getByRole('button', { name: 'ENTER THE ARENA' }).click()
    await page.getByRole('button', { name: 'RETRY SETUP' }).waitFor()
    assert.ok(await page.getByRole('alert').textContent())
    assert.equal(await page.getByText('Confirmed ·', { exact: false }).count(), 0)
    await page.getByRole('button', { name: 'RETRY SETUP' }).click()
    await page.getByRole('button', { name: 'RETRY SETUP' }).waitFor()
    assert.ok(networkCalls > 0)
    console.log(`PASS ${width}px: canvas, layout, zero prestart network calls, truthful setup failure + retry`)
    await page.close()
  }
  assert.deepEqual(errors, [], 'No browser runtime errors')
  console.log('PASS browser smoke; no faucet consumed, no live settlement tested')
} finally { await browser.close() }
