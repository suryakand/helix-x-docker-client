/** Runs at most `max` async tasks at once; the rest wait in FIFO order. */
export class Limiter {
  private active = 0
  private readonly queue: (() => void)[] = []

  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.queue.push(resolve))
    this.active++
    try {
      return await fn()
    } finally {
      this.active--
      this.queue.shift()?.()
    }
  }
}
