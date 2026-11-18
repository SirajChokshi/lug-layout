const INITIAL_CAPACITY = 256;

export class MateReport {
  private size = 0;
  private connectors: Int32Array;
  private sources: Uint8Array;
  private families: Uint8Array;

  constructor(capacity: number = INITIAL_CAPACITY) {
    this.connectors = new Int32Array(capacity);
    this.sources = new Uint8Array(capacity);
    this.families = new Uint8Array(capacity);
  }

  get count(): number {
    return this.size;
  }

  get connector(): Int32Array {
    return this.connectors;
  }

  get source(): Uint8Array {
    return this.sources;
  }

  get family(): Uint8Array {
    return this.families;
  }

  clear(): void {
    this.size = 0;
  }

  push(connector: number, source: number): void {
    if (this.size === this.connectors.length) this.grow();
    this.connectors[this.size] = connector;
    this.sources[this.size] = source;
    this.size++;
  }

  assignFamily(from: number, family: number): void {
    this.families.fill(family, from, this.size);
  }

  private grow(): void {
    const capacity = Math.max(1, this.connectors.length * 2);
    const connectors = new Int32Array(capacity);
    connectors.set(this.connectors);
    this.connectors = connectors;
    const sources = new Uint8Array(capacity);
    sources.set(this.sources);
    this.sources = sources;
    const families = new Uint8Array(capacity);
    families.set(this.families);
    this.families = families;
  }
}
