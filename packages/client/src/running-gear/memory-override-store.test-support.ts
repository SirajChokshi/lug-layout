import type { RunningGearOverride } from "@brr/schema/bundle";
import type { IRunningGearOverrideStore } from "./override-store.ts";

export class MemoryOverrideStore implements IRunningGearOverrideStore {
  readonly records = new Map<string, RunningGearOverride>();

  async load(modelSha256: string): Promise<RunningGearOverride | null> {
    return this.records.get(modelSha256) ?? null;
  }
  async save(override: RunningGearOverride): Promise<void> {
    this.records.set(override.modelSha256, structuredClone(override));
  }
  async remove(modelSha256: string): Promise<void> {
    this.records.delete(modelSha256);
  }
  async all(): Promise<ReadonlyArray<RunningGearOverride>> {
    return [...this.records.values()];
  }
}
