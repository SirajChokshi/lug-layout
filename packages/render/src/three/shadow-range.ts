export const SHADOW_FAR_HYSTERESIS = 1.25;

export class ShadowRange {
  private farLdu = 0;
  private lastNeededLdu = Number.NaN;

  get far(): number {
    return this.farLdu;
  }

  get atRest(): boolean {
    return this.farLdu === this.lastNeededLdu * SHADOW_FAR_HYSTERESIS;
  }

  fit(neededLdu: number): boolean {
    const still = neededLdu === this.lastNeededLdu;
    this.lastNeededLdu = neededLdu;
    const restRange = neededLdu * SHADOW_FAR_HYSTERESIS;
    const keeps = still ? this.farLdu === restRange : this.covers(neededLdu);
    if (keeps) return false;
    this.farLdu = restRange;
    return true;
  }

  private covers(neededLdu: number): boolean {
    return neededLdu <= this.farLdu && neededLdu * SHADOW_FAR_HYSTERESIS >= this.farLdu;
  }
}
