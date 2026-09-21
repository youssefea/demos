import test from 'node:test'
import assert from 'node:assert/strict'
import { refundSummary } from '../src/refund-summary.ts'

test('actual agreement and unchanged-price draws have different explanations', () => {
  assert.equal(refundSummary('Same prediction. Both stakes are returned. Refunds confirmed.', 'up'), 'Both picked Up — refunded.')
  assert.equal(refundSummary('Same prediction. Both stakes are returned.', 'down'), 'Both picked Down — refunded.')
  assert.equal(refundSummary('Price unchanged. Both stakes are returned.', 'up'), 'BTC stayed flat — refunded.')
})
test('interrupted rounds are never mislabeled as Jev agreeing with the human', () => {
  assert.equal(refundSummary('Price feed interrupted. Returning confirmed stakes.', 'up'), 'Price feed interrupted — refunded.')
  assert.equal(refundSummary('Price feed proof timed out at the cutoff. Returning both stakes.', 'up'), 'Price feed timed out — refunded.')
  assert.equal(refundSummary('Tab hidden. Returning confirmed stakes.', 'down'), 'Tab was hidden — refunded.')
  assert.equal(refundSummary('Clock changed. Returning confirmed stakes.', 'up'), 'Device clock changed — refunded.')
  assert.equal(refundSummary('A stake failed. Refunding confirmed contributions only.', 'up'), 'A stake failed — confirmed funds returned.')
})
