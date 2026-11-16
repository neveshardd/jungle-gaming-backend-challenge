import type { Logger } from '../../shared/application/logger';

/**
 * Runs `tick` repeatedly: immediately again when it reports more work, otherwise after
 * `intervalMs`. `stop()` waits for the in-flight tick (graceful shutdown).
 */
export class PollingLoop {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private current: Promise<void> | undefined;

  constructor(
    private readonly name: string,
    private readonly intervalMs: number,
    private readonly tick: () => Promise<boolean>,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    await this.current;
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.current = this.runOnce().then((more) => {
        this.current = undefined;
        this.schedule(more ? 0 : this.intervalMs);
      });
    }, delayMs);
  }

  private async runOnce(): Promise<boolean> {
    try {
      return await this.tick();
    } catch (err) {
      this.logger.error({ loop: this.name, reason: err instanceof Error ? err.message : String(err) }, 'background loop iteration failed');
      return false;
    }
  }
}
