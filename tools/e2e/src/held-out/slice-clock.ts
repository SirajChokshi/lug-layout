export const SLICE_CLOCK_STEP_MS = 0.025;
export const EDITOR_FIRST_SLICE_MS = 6;
export const FIRST_SLICE_READ_BUDGET = Math.ceil(EDITOR_FIRST_SLICE_MS / SLICE_CLOCK_STEP_MS);

export class SliceClock {
  private readonly realNow = performance.now.bind(performance);
  private installed = false;
  private reads = 0;
  private fakeMs = 0;
  private publishRead: number | null = null;

  realMs(): number {
    return this.realNow();
  }

  readsToFirstPublish(): number | null {
    return this.publishRead;
  }

  published(): void {
    if (this.installed && this.publishRead === null) this.publishRead = this.reads;
  }

  async during<T>(work: () => Promise<T>): Promise<T> {
    this.reads = 0;
    this.publishRead = null;
    this.fakeMs = this.realNow();
    Object.defineProperty(performance, "now", {
      configurable: true,
      writable: true,
      value: (): number => {
        this.reads++;
        this.fakeMs += SLICE_CLOCK_STEP_MS;
        return this.fakeMs;
      },
    });
    this.installed = true;
    try {
      return await work();
    } finally {
      this.installed = false;
      Reflect.deleteProperty(performance, "now");
    }
  }
}
