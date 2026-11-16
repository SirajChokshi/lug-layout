export interface IdleWork {
  work(deadlineMs: number): boolean;
}

export class IdleWorkLoop {
  private readonly channel = new MessageChannel();
  private armed = false;

  constructor(
    private readonly job: IdleWork,
    private readonly sliceMs: number,
  ) {
    this.channel.port1.addEventListener("message", this.run);
    this.channel.port1.start();
  }

  wake(): void {
    if (this.armed) return;
    this.armed = true;
    this.channel.port2.postMessage(null);
  }

  private readonly run = (): void => {
    this.armed = false;
    const more = this.job.work(performance.now() + this.sliceMs);
    if (more) this.wake();
  };
}
