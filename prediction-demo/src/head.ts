/** HTTP responses and WSS notifications may arrive out of order. A lower head is not reset evidence. */
export class ChainHead {
  number: number
  seenAt = 0
  constructor(initial: number) { this.number = initial }
  observe(number: number, now: number) {
    if (Number.isSafeInteger(number) && number > this.number) { this.number = number; this.seenAt = now }
  }
  stale(now: number) { return this.seenAt === 0 || now - this.seenAt > 8_000 }
}
