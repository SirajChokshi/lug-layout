export interface PlanExtent {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

export class SceneBounds {
  private minX = Number.POSITIVE_INFINITY;
  private maxX = Number.NEGATIVE_INFINITY;
  private minZ = Number.POSITIVE_INFINITY;
  private maxZ = Number.NEGATIVE_INFINITY;
  private stale = false;

  extend(extent: PlanExtent): void {
    this.minX = Math.min(this.minX, extent.minX);
    this.maxX = Math.max(this.maxX, extent.maxX);
    this.minZ = Math.min(this.minZ, extent.minZ);
    this.maxZ = Math.max(this.maxZ, extent.maxZ);
  }

  invalidate(): void {
    this.stale = true;
  }

  refresh(live: ReadonlyArray<PlanExtent>): void {
    if (!this.stale) return;
    this.stale = false;
    this.minX = Number.POSITIVE_INFINITY;
    this.maxX = Number.NEGATIVE_INFINITY;
    this.minZ = Number.POSITIVE_INFINITY;
    this.maxZ = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < live.length; i++) {
      const extent = live[i];
      if (extent) this.extend(extent);
    }
  }

  reachFrom(eyeX: number, eyeY: number, eyeZ: number): number {
    const dx = Math.max(Math.abs(this.minX - eyeX), Math.abs(this.maxX - eyeX));
    const dz = Math.max(Math.abs(this.minZ - eyeZ), Math.abs(this.maxZ - eyeZ));
    return Math.hypot(dx, dz, eyeY);
  }
}
